# HeyPost Backend

Backend mandiri untuk HeyPost, menggunakan Hono, tRPC, Drizzle ORM, dan SQLite.

## Menjalankan di VPS

Persyaratan: Node.js 22 atau lebih baru.

```bash
git clone https://github.com/YosmerryGod/heypost-backend.git
cd heypost-backend
cp .env.example .env
npm install
npm run db:push
npm run check
npm run build
npm start
```

Server menggunakan port `3111` secara default. Database dibuat otomatis di `data/heypost.db`; MySQL tidak diperlukan.

Endpoint pemeriksaan:

```bash
curl http://127.0.0.1:3111/api/health
curl http://127.0.0.1:3111/api/trpc/ping
```

Untuk development dengan auto-reload:

```bash
npm run dev
```

## Environment

```env
DATABASE_URL=file:./data/heypost.db
PORT=3111
```

Folder `data/` tidak disimpan ke Git. Backup folder tersebut bersama file database dan journal SQLite saat melakukan backup.

## Update backend

```bash
git pull origin main
npm install
npm run db:push
npm run check
npm run build
systemctl restart heypost-backend
```

Periksa perubahan skema sebelum menyetujui `db:push`. Jangan gunakan `--force` pada database yang berisi data.

## Catatan produksi

- `better-sqlite3` adalah dependensi native. Jika prebuilt binary tidak tersedia, VPS memerlukan `python3`, `make`, dan `g++`.
- Hasil build memuat dependensi native sebagai external, jangan menghapus `node_modules` setelah build.
- Endpoint POS saat ini bersifat publik. Tambahkan autentikasi sebelum dipakai untuk operasional toko sebenarnya.
