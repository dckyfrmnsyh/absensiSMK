/**
 * sync-manager.js (REVISED untuk absensiSMK)
 * Modul Sinkronisasi Offline-First yang disesuaikan dengan skema aplikasi saat ini
 *
 * Perubahan dari versi asli:
 * - Sesuaikan dengan tabel `attendances` dan bucket `photos`
 * - Field names: student_nis, student_name, jam_masuk, jam_keluar, photo_url
 * - Hilangkan ketergantungan pada tabel `profiles` dan role (kecuali opsional)
 * - Nama file foto lebih sederhana (absen-{id}-{timestamp}.jpg)
 * - Lebih ringkas dan mudah diintegrasikan dengan index.html yang sudah diperbaiki
 * - IndexedDB + real Blob untuk foto (lebih efisien daripada base64)
 *
 * Cara pakai (opsional - untuk upgrade):
 * 1. Letakkan file ini di root proyek
 * 2. Tambahkan di index.html: <script src="sync-manager.js.revised.js"></script>
 * 3. Panggil: initSyncManager(supabaseClient, { nis: profile.nis, nama: profile.nama })
 * 4. Gunakan window.saveAttendanceOfflineFirst() saat check-in/check-out + foto
 */

(function () {
  'use strict';

  let sb = null;
  let currentProfile = null; // { nis, nama, kelas, tempat_pkl }
  let dbName = 'absensiSMK_offline_v1';
  let storeName = 'attendances_queue';

  // =====================================================
  // INISIALISASI
  // =====================================================
  window.initSyncManager = function (supabaseClient, profileData) {
    sb = supabaseClient;
    currentProfile = profileData || {};

    ensureIndexedDBSchema();
    initNetworkListeners();

    if (navigator.onLine) {
      setTimeout(() => syncPendingRecords(), 1800);
    }

    console.log('%c[SyncManager] Initialized for NIS:', 'color:#3ecf8e', currentProfile.nis || 'unknown');
  };

  // =====================================================
  // INDEXEDDB HELPERS
  // =====================================================
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);

      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        let store;

        if (!database.objectStoreNames.contains(storeName)) {
          store = database.createObjectStore(storeName, { keyPath: 'id' });
        } else {
          store = e.target.transaction.objectStore(storeName);
        }

        if (!store.indexNames.contains('sync_status')) {
          store.createIndex('sync_status', 'sync_status', { unique: false });
        }
        if (!store.indexNames.contains('tanggal')) {
          store.createIndex('tanggal', 'tanggal', { unique: false });
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
      console.error('[SyncManager] IndexedDB schema error:', err);
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
      (r.photoBlob && !r.photo_url)
    );
  }

  async function idbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  // =====================================================
  // UPLOAD FOTO (menggunakan Blob asli)
  // =====================================================
  async function uploadPhotoToStorage(photoBlob, recordId) {
    if (!sb || !photoBlob) return null;

    try {
      const fileName = `absen-${recordId}-${Date.now()}.jpg`;

      const { data, error } = await sb.storage
        .from('photos')
        .upload(fileName, photoBlob, {
          contentType: 'image/jpeg',
          upsert: false
        });

      if (error) throw error;

      const { data: urlData } = sb.storage
        .from('photos')
        .getPublicUrl(fileName);

      return urlData.publicUrl;
    } catch (err) {
      console.error('[SyncManager] Upload foto gagal:', err);
      throw err;
    }
  }

  // =====================================================
  // SYNC LOGIC (disesuaikan dengan skema attendances)
  // =====================================================
  async function syncSingleRecord(localId) {
    if (!sb) {
      console.warn('[SyncManager] Supabase client belum siap');
      return false;
    }

    const record = await idbGetById(localId);
    if (!record || record.sync_status === 'synced') return true;

    try {
      let photo_url = record.photo_url;

      // 1. Upload foto jika ada Blob dan belum ada URL
      if (record.photoBlob && !photo_url) {
        photo_url = await uploadPhotoToStorage(record.photoBlob, record.id);
        console.log('%c[SyncManager] Foto berhasil diupload:', 'color:#3ecf8e', photo_url);
      }

      // 2. Siapkan payload sesuai skema aplikasi
      const payload = {
        id: record.id,
        student_nis: record.student_nis || currentProfile.nis || null,
        student_name: record.student_name || currentProfile.nama || null,
        tanggal: record.tanggal,
        jam_masuk: record.jam_masuk,
        jam_keluar: record.jam_keluar || null,
        lat: record.lat || null,
        lng: record.lng || null,
        status_masuk: record.status_masuk || 'Hadir',
        photo_url: photo_url || record.photo_url || null
      };

      // 3. Upsert ke tabel attendances
      const { error } = await sb
        .from('attendances')
        .upsert(payload);

      if (error) throw error;

      // 4. Update local: hapus Blob (hemat storage), tandai synced
      const updated = {
        ...record,
        photo_url: photo_url,
        photoBlob: null,
        sync_status: 'synced',
        last_synced: new Date().toISOString()
      };

      await idbPut(updated);
      console.log('%c[SyncManager] Record synced:', 'color:#3ecf8e', localId);
      return true;

    } catch (err) {
      console.error('[SyncManager] Gagal sync record:', localId, err);
      return false;
    }
  }

  // Sinkronisasi semua data pending
  window.syncPendingRecords = async function () {
    if (!navigator.onLine) {
      return { success: 0, failed: 0, message: 'Offline' };
    }

    const pending = await idbGetPending();
    if (pending.length === 0) {
      return { success: 0, failed: 0, message: 'Tidak ada data pending' };
    }

    let success = 0;
    let failed = 0;

    for (const rec of pending) {
      const ok = await syncSingleRecord(rec.id);
      if (ok) success++;
      else failed++;
    }

    const result = {
      success,
      failed,
      total: pending.length,
      message: `${success} berhasil, ${failed} gagal`
    };

    console.log('[SyncManager] Hasil sync batch:', result);
    return result;
  };

  // =====================================================
  // PUBLIC API - Untuk dipanggil dari index.html
  // =====================================================

  /**
   * Simpan absensi + foto secara offline-first
   * @param {Object} recordData - data absensi (id, tanggal, jam_masuk, dll)
   * @param {Blob|File|null} photoBlob - foto dari kamera (opsional)
   */
  window.saveAttendanceOfflineFirst = async function (recordData, photoBlob = null) {
    if (!recordData || !recordData.id) {
      throw new Error('recordData harus memiliki id');
    }

    const localRecord = {
      ...recordData,
      student_nis: recordData.student_nis || currentProfile.nis,
      student_name: recordData.student_name || currentProfile.nama,
      photoBlob: photoBlob || null,
      sync_status: 'pending',
      timestamp: Date.now()
    };

    await idbPut(localRecord);

    // Jika online, langsung coba sync di background
    if (navigator.onLine && sb) {
      setTimeout(() => syncSingleRecord(localRecord.id), 600);
    }

    return localRecord.id;
  };

  /**
   * Ambil semua data absensi (prioritas IndexedDB)
   */
  window.loadAttendanceData = async function () {
    return await idbGetAll();
  };

  /**
   * Hapus record dari queue (jika perlu)
   */
  window.deletePendingRecord = async function (id) {
    return await idbDelete(id);
  };

  window.getPendingCount = async function () {
    const pending = await idbGetPending();
    return pending.length;
  };

  // =====================================================
  // NETWORK LISTENERS
  // =====================================================
  function initNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('%c[SyncManager] Koneksi pulih - auto sync dimulai', 'color:#3ecf8e');
      syncPendingRecords();
    });

    window.addEventListener('offline', () => {
      console.log('%c[SyncManager] Mode offline aktif', 'color:#f59e0b');
    });

    // Auto sync berkala setiap 6 menit
    setInterval(() => {
      if (navigator.onLine && sb) {
        syncPendingRecords();
      }
    }, 6 * 60 * 1000);
  }

  // Expose untuk debugging
  window.debugSyncManager = {
    getAll: idbGetAll,
    getPending: idbGetPending,
    forceSync: syncPendingRecords,
    clearAll: async () => {
      const all = await idbGetAll();
      for (const r of all) await idbDelete(r.id);
      console.log('[SyncManager] Semua data lokal dihapus');
    }
  };

  console.log('%c[SyncManager] Module loaded. Panggil initSyncManager(sb, profile) untuk mengaktifkan.', 'color:#64748b');
})();
