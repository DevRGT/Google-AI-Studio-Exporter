export const IDB_DB_NAME = 'AIStudioExporterDB';
export const IDB_STORE_NAME = 'handles';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_DB_NAME, 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
                db.createObjectStore(IDB_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function setDirectoryHandle(key, handle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(IDB_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(IDB_STORE_NAME);
        const request = store.put(handle, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function getDirectoryHandle(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(IDB_STORE_NAME, 'readonly');
        const store = transaction.objectStore(IDB_STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function clearDirectoryHandle(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(IDB_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(IDB_STORE_NAME);
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
