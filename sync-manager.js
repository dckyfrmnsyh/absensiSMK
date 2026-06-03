/**
 * sync-manager.js
 * Modul Sinkronisasi Offline-First untuk absensiSMK
 * 
 * Cara pakai:
 * 1. Buat folder /js di project Anda (atau letakkan di root)
 * 2. Tambahkan di index.html: <script src="js/sync-manager.js"></script>
 * 3. Panggil initSyncManager() setelah login berhasil
 * 
 * Fitur:
 * - Simpan ke IndexedDB dulu (dengan photoBlob)
 * - Queue pending records
 * - Auto sync saat online
 * - Manual sync via tombol
 * - Upload foto otomatis saat sync
 * - Hemat storage: hapus photoBlob setelah berhasil sync
 */

(function() {
  'use strict';

  let sb = null;           // Supabase client (akan di-inject)
  let currentUser = null;  // {id, role, nis, ...}
  let dbName = 'SMKN1TT_v4';
  let storeName = 'absensi_cache';

  // =====================================================
  // INISIALISASI
  // =====================================================
  window.initSyncManager = function(supabaseClient, user) {
    sb = supabaseClient;
    currentUser = user;
    
    // Pastikan IndexedDB sudah siap dengan index sync_status
    ensureIndexedDBSchema();
    
    // Listener koneksi internet
    initNetworkListeners();
    
    // Cek pending records saat startup (jika online)
    if (navigator.onLine) {
      setTimeout(() => syncPendingRecords(), 2000);
    }
    
    console.log('[SyncManager] Initialized for user:', currentUser?.nis || currentUser?.id);
  };

  // =====================================================
  // HELPER INDEXEDDB (Enhanced)
  // =====================================================
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 2); // Version 2 untuk sync_status
      
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        let store;
        
        if (!database.objectStoreNames.contains(storeName)) {
          store = database.createObjectStore(storeName, { keyPath: 'id' });
        } else {
          store = e.target.transaction.objectStore(storeName);
        }
        
        // Pastikan index ada
        if (!store.indexNames.contains('sync_status')) {
          store.createIndex('sync_status', 'sync_status', { unique: false });
        }
        if (!store.indexNames.contains('nis')) {
          store.createIndex('nis', 'nis', { unique: false });
        }
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function ensureIndexedDBSchema() {
    try {
      const db = await openDB();
      db.close();
    } catch (err) {
      console.error('[SyncManager] Failed to ensure DB schema:', err);
    }
  }

  async function idbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbGetById(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbGetPending() {
    const all = await idbGetAll();
    return all.filter(r => 
      r.sync_status === 'pending' || 
      (r.photoBlob && !r.foto_url)
    );
  }

  // =====================================================
  // UPLOAD FOTO KE SUPABASE STORAGE
  // =====================================================
  async function uploadPhotoToStorage(photoBlob, userId) {
    if (!sb || !photoBlob || !userId) return null;

    try {
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 8);
      const fileName = `${userId}/${timestamp}_${random}.jpg`;

      const { data, error } = await sb.storage
        .from('foto-absensi')
        .upload(fileName, photoBlob, {
          contentType: 'image/jpeg',
          upsert: false
        });

      if (error) throw error;

      const { data: urlData } = sb.storage
        .from('foto-absensi')
        .getPublicUrl(fileName);

      return urlData.publicUrl;
    } catch (err) {
      console.error('[SyncManager] Upload photo failed:', err);
      throw err;
    }
  }

  // =====================================================
  // SYNC LOGIC
  // =====================================================
  async function syncSingleRecord(localId) {
    if (!sb || !currentUser) {
      console.warn('[SyncManager] Supabase client or user not ready');
      return false;
    }

    const record = await idbGetById(localId);
    if (!record || record.sync_status === 'synced') return true;

    try {
      let foto_url = record.foto_url;

      // 1. Upload foto jika masih ada Blob dan belum ada URL
      if (record.photoBlob && !foto_url) {
        foto_url = await uploadPhotoToStorage(record.photoBlob, record.user_id || currentUser.id);
        console.log('[SyncManager] Photo uploaded:', foto_url);
      }

      // 2. Siapkan payload untuk Supabase (hapus field lokal)
      const payload = { ...record };
      delete payload.photoBlob;
      delete payload.sync_status;
      delete payload.last_synced;

      payload.foto_url = foto_url;
      payload.recorded_by = currentUser.id;
      
      // Pastikan user_id terisi (penting untuk RLS)
      if (!payload.user_id && record.nis) {
        // Fallback: cari user_id dari profiles berdasarkan nis (jika ada)
        const { data: profile } = await sb
          .from('profiles')
          .select('id')
          .eq('nis', record.nis)
          .single();
        if (profile) payload.user_id = profile.id;
      }

      // 3. Upsert ke Supabase (hindari duplikat)
      const { data: inserted, error } = await sb
        .from('absensi')
        .upsert(payload, { 
          onConflict: 'nis,tanggal,waktu',
          ignoreDuplicates: false 
        })
        .select()
        .single();

      if (error) throw error;

      // 4. Update local record: hapus Blob, tandai synced
      const updatedRecord = {
        ...record,
        ...inserted,
        photoBlob: null,           // Hemat storage!
        sync_status: 'synced',
        last_synced: new Date().toISOString()
      };

      await idbPut(updatedRecord);
      console.log('[SyncManager] Record synced successfully:', localId);
      return true;

    } catch (err) {
      console.error('[SyncManager] Sync single record failed:', err);
      // Biarkan tetap pending, akan dicoba lagi nanti
      return false;
    }
  }

  // Sinkronisasi SEMUA data pending
  window.syncPendingRecords = async function() {
    if (!navigator.onLine) {
      console.log('[SyncManager] Offline - skip sync');
      return { success: 0, failed: 0, message: 'Offline' };
    }

    const pendingRecords = await idbGetPending();
    if (pendingRecords.length === 0) {
      return { success: 0, failed: 0, message: 'Tidak ada data pending' };
    }

    let success = 0;
    let failed = 0;

    for (const rec of pendingRecords) {
      const ok = await syncSingleRecord(rec.id);
      if (ok) success++;
      else failed++;
    }

    const result = { 
      success, 
      failed, 
      total: pendingRecords.length,
      message: `${success} berhasil, ${failed} gagal` 
    };

    console.log('[SyncManager] Batch sync result:', result);
    return result;
  };

  // =====================================================
  // PUBLIC API - Digunakan dari index.html
  // =====================================================

  // Simpan absensi secara offline-first (PANGGIL INI dari submitAbsen)
  window.saveAttendanceOfflineFirst = async function(record, photoBlob) {
    if (!record) throw new Error('Record tidak boleh kosong');

    const localRecord = {
      ...record,
      id: record.id || crypto.randomUUID(),
      photoBlob: photoBlob || null,
      sync_status: 'pending',
      timestamp: record.timestamp || Date.now(),
      created_at: record.created_at || new Date().toISOString()
    };

    // Selalu simpan ke IndexedDB dulu
    await idbPut(localRecord);

    // Jika online, langsung coba sync
    if (navigator.onLine && sb && currentUser) {
      // Jalankan di background agar UI tidak freeze
      setTimeout(() => syncSingleRecord(localRecord.id), 100);
    }

    return localRecord.id;
  };

  // Load semua data (untuk rekap/admin & riwayat siswa)
  // Prioritas: IndexedDB (offline capable) + background refresh dari Supabase
  window.loadAttendanceData = async function(filter = {}) {
    // 1. Ambil dari local cache dulu (cepat + offline)
    let localData = await idbGetAll();

    // Filter berdasarkan role
    if (currentUser?.role === 'student') {
      localData = localData.filter(r => 
        r.user_id === currentUser.id || 
        (r.nis && r.nis === currentUser.nis)
      );
    }

    // Apply filter tambahan (tanggal, nis, dll)
    if (filter.nis) {
      localData = localData.filter(r => r.nis === filter.nis);
    }
    if (filter.startDate && filter.endDate) {
      localData = localData.filter(r => {
        const d = r.tanggal || r.date;
        return d >= filter.startDate && d <= filter.endDate;
      });
    }

    // 2. Background refresh dari Supabase (jika online)
    if (navigator.onLine && sb && currentUser) {
      setTimeout(async () => {
        try {
          let query = sb.from('absensi').select('*');
          
          if (currentUser.role === 'student') {
            query = query.eq('user_id', currentUser.id);
          }
          // Admin dapat semua (RLS sudah handle)

          if (filter.startDate) query = query.gte('tanggal', filter.startDate);
          if (filter.endDate) query = query.lte('tanggal', filter.endDate);

          const { data: cloudData, error } = await query.order('tanggal', { ascending: false });

          if (!error && cloudData) {
            // Merge ke IndexedDB
            for (const cloudRec of cloudData) {
              const existing = localData.find(l => l.id === cloudRec.id);
              if (!existing || new Date(cloudRec.last_synced || 0) > new Date(existing.last_synced || 0)) {
                await idbPut({
                  ...cloudRec,
                  photoBlob: null,
                  sync_status: 'synced'
                });
              }
            }
            console.log('[SyncManager] Background refresh completed');
          }
        } catch (e) {
          console.warn('[SyncManager] Background refresh failed (non-critical):', e);
        }
      }, 500);
    }

    return localData;
  };

  // =====================================================
  // NETWORK LISTENERS
  // =====================================================
  function initNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('[SyncManager] Connection restored - starting auto sync');
      if (typeof showToast === 'function') {
        showToast('Koneksi pulih. Sinkronisasi otomatis dimulai...');
      }
      syncPendingRecords();
    });

    window.addEventListener('offline', () => {
      console.log('[SyncManager] Connection lost - working offline');
      if (typeof showToast === 'function') {
        showToast('Mode offline aktif. Data akan disimpan lokal.');
      }
    });

    // Periodic check setiap 5 menit (jika online)
    setInterval(() => {
      if (navigator.onLine) {
        syncPendingRecords();
      }
    }, 5 * 60 * 1000);
  }

  // =====================================================
  // UTILITAS
  // =====================================================
  window.getPendingCount = async function() {
    const pending = await idbGetPending();
    return pending.length;
  };

  // Expose untuk debugging
  window.debugSyncManager = {
    getAllLocal: idbGetAll,
    getPending: idbGetPending,
    forceSync: syncPendingRecords
  };

  console.log('[SyncManager] Module loaded. Call initSyncManager(sb, currentUser) after login.');
})();