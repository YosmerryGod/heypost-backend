# HeyPost Backend

Backend mandiri HeyPost menggunakan Hono, tRPC, Drizzle ORM, dan SQLite. Mendukung autentikasi owner, Google OAuth, multi-outlet, karyawan dengan role, serta login karyawan menggunakan barcode dan PIN.

## Aturan akses

- Satu akun owner memiliki tepat satu toko.
- Satu toko dapat memiliki banyak outlet.
- Setiap outlet memiliki kategori, produk, stok, transaksi, dan laporan sendiri.
- Satu karyawan ditugaskan ke satu outlet.
- Owner dapat berpindah outlet dan melihat rekap gabungan seluruh outlet.
- Manager dapat mengelola menu, stok, transaksi, dan laporan outletnya.
- Kasir dapat membuka katalog, membuat transaksi, dan melihat riwayat outletnya.
- Hanya owner yang dapat membuat/mengubah outlet dan mengelola karyawan.

Semua pembatasan dilakukan di backend menggunakan sesi, `storeId`, dan `outletId`. Frontend tidak dapat menentukan toko atau outlet lain melalui input API.

## Menjalankan di VPS

Persyaratan: Node.js 22 atau lebih baru. `better-sqlite3` dapat memerlukan `python3`, `make`, dan `g++` jika prebuilt binary tidak tersedia.

```bash
git clone https://github.com/YosmerryGod/heypost-backend.git
cd heypost-backend
cp .env.example .env
nano .env
npm install
npm run db:push
npm run check
npm run build
npm start
```

Server menggunakan port `3111` secara default. Database dibuat di `data/heypost.db`; MySQL tidak diperlukan.

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

Contoh produksi:

```env
DATABASE_URL=file:./data/heypost.db
PORT=3111
NODE_ENV=production

PUBLIC_API_URL=https://apihey.doodweb.tech
FRONTEND_URL=https://app.domain-frontend.com

GOOGLE_CLIENT_ID=isi-client-id-google
GOOGLE_CLIENT_SECRET=isi-client-secret-google
GOOGLE_REDIRECT_URI=https://apihey.doodweb.tech/api/auth/google/callback
GOOGLE_SUCCESS_URL=https://app.domain-frontend.com/auth/callback
```

`FRONTEND_URL` harus berupa origin frontend yang sebenarnya, tanpa garis miring di akhir. Backend hanya memberikan CORS dengan credentials ke origin tersebut. Cookie sesi produksi memakai `HttpOnly`, `Secure`, dan `SameSite=None`, sehingga frontend dan API harus menggunakan HTTPS.

Jangan mengunggah `.env` ke Git. Setelah mengubah environment di VPS, jalankan `systemctl restart heypost-backend`.

## Konfigurasi login Google

1. Buka Google Cloud Console dan buat/pilih project.
2. Aktifkan OAuth consent screen.
3. Buat OAuth Client dengan tipe **Web application**.
4. Tambahkan authorized redirect URI:

   ```text
   https://apihey.doodweb.tech/api/auth/google/callback
   ```

5. Salin Client ID dan Client Secret ke `.env` backend.
6. Isi `GOOGLE_SUCCESS_URL` dengan halaman callback frontend.
7. Restart service backend.

Endpoint Google:

- `GET /api/auth/google/start` — memulai OAuth dengan state dan PKCE.
- `GET /api/auth/google/callback` — menukar kode, memverifikasi profil/email, lalu membuat sesi.

Login Google pertama kali otomatis membuat owner, satu toko, dan Outlet Utama. Email Google harus terverifikasi. Jika email sudah memiliki akun owner, akun Google dihubungkan ke akun tersebut.

## API autentikasi

Semua procedure berikut berada di namespace tRPC:

| Procedure | Akses | Fungsi |
| --- | --- | --- |
| `auth.register` | Publik | Register owner, toko, dan outlet utama |
| `auth.login` | Publik | Login owner dengan email/password |
| `auth.employeeLogin` | Publik | Login karyawan dengan barcode dan PIN 6 digit |
| `auth.me` | Opsional | Profil, role, toko, daftar outlet, dan outlet aktif |
| `auth.logout` | Login | Menghapus sesi dan cookie |

Contoh register:

```bash
curl -i -c cookies.txt http://127.0.0.1:3111/api/trpc/auth.register \
  -H 'Content-Type: application/json' \
  -d '{"json":{"name":"Owner","storeName":"Toko Saya","outletName":"Outlet Utama","email":"owner@example.com","password":"password123"}}'
```

Frontend harus mengirim cookie pada request tRPC (`credentials: "include"`). Jangan menyimpan barcode, PIN, password, atau token sesi di log frontend.

## Outlet dan karyawan

Namespace `store` (khusus owner):

- `store.createOutlet` — membuat outlet; `copyMenuFromOutletId` bersifat opsional untuk menyalin kategori dan menu.
- `store.switchOutlet` — mengganti outlet aktif pada sesi owner.
- `store.updateOutlet` — mengubah nama, alamat, atau status outlet.

Namespace `employees` (khusus owner):

- `employees.list` — daftar karyawan tanpa PIN maupun hash barcode.
- `employees.create` — menambah manager/kasir ke satu outlet dan mengembalikan barcode plaintext satu kali.
- `employees.update` — mengubah role, outlet, PIN, atau status aktif; sesi lama karyawan dihapus.
- `employees.regenerateBarcode` — mencabut barcode lama, membuat barcode baru, dan menghapus sesi karyawan.

Database hanya menyimpan hash barcode. PIN di-hash dengan salt. Lima kegagalan PIN mengunci login karyawan selama 15 menit; tersedia juga pembatasan percobaan login berdasarkan jaringan. Barcode bukan pengganti PIN dan harus diperlakukan sebagai kredensial.

## POS dan laporan

- `pos.bootstrap`, `pos.createTransaction`, dan `pos.transactions` dapat digunakan semua role yang login.
- `pos.createCategory`, `pos.createProduct`, `pos.updateProduct`, dan `pos.archiveProduct` hanya untuk owner/manager.
- `pos.summary` hanya untuk owner/manager.
- `pos.summary` menerima `allOutlets: true` hanya dari owner untuk rekap gabungan.

Katalog dan transaksi baru selalu memakai outlet aktif dari sesi. Produk dari outlet lain tidak dapat dipakai untuk transaksi maupun diubah.

### Pengeluaran operasional

Pencatatan pengeluaran disimpan terpisah dari transaksi penjualan. Setiap catatan terikat pada toko dan outlet aktif dari sesi; client tidak dapat mengirim atau memilih `storeId` maupun `outletId`.

Namespace tRPC `expenses` (khusus owner/manager):

| Procedure | Fungsi |
| --- | --- |
| `expenses.create` | Mencatat kategori, nominal Rupiah, keterangan opsional, metode pembayaran, dan tanggal pengeluaran. |
| `expenses.list` | Mengambil maksimal 500 catatan pengeluaran outlet aktif; rentang `fromDate` dan `toDate` opsional memakai format `YYYY-MM-DD`. |

Setiap catatan menyimpan identitas owner/karyawan yang membuatnya. API belum menyediakan edit atau hapus agar riwayat pencatatan tidak berubah tanpa jejak. Nominal disimpan sebagai bilangan bulat Rupiah. Kasir tidak memiliki akses ke endpoint pengeluaran; pencatatan dan pembacaan hanya untuk owner/manager.

## Database lama sebelum autentikasi

Jalankan `npm run db:push` seperti biasa. Kolom tenant pada data lama dibiarkan `NULL` agar migrasi tidak menghapus data dan tidak memberikan data tersebut kepada pendaftar baru secara otomatis.

Setelah owner yang berhak terdaftar dan ID outlet diketahui, hubungkan data lama secara eksplisit:

```bash
LEGACY_OWNER_EMAIL=owner@example.com \
LEGACY_OUTLET_ID=1 \
npm run db:attach-legacy
```

Script memindahkan kategori, produk, dan transaksi lama yang belum memiliki tenant ke toko/outlet tersebut. Jalankan sebelum membuat kategori dengan nama yang sama di outlet tujuan. Backup database terlebih dahulu.

## Data demo opsional

Outlet baru tidak lagi diisi transaksi demo secara otomatis. Untuk mengisi 15 produk dan 7 transaksi demo ke outlet kosong:

```bash
SEED_OUTLET_ID=1 npm run db:seed
```

Seed dibatalkan jika outlet sudah memiliki kategori.

## Update backend

Backup database terlebih dahulu. Dengan utilitas `sqlite3`:

```bash
cd /opt/heypost-backend
mkdir -p backups
sqlite3 data/heypost.db ".backup 'backups/heypost-$(date +%Y%m%d-%H%M%S).db'"

git pull origin main
npm install
npm run db:push
npm run check
npm run build
chown -R heypost:heypost /opt/heypost-backend
systemctl restart heypost-backend
curl http://127.0.0.1:3111/api/health
```

Periksa perubahan skema sebelum menyetujui `db:push`. Jangan gunakan `--force` pada database berisi data. Folder `data/`, direktori backup, dan `.env` tidak boleh diunggah ke Git.

Hasil build memuat `better-sqlite3` sebagai external, jadi jangan menghapus `node_modules` setelah build. Konfigurasi Nginx yang sudah mengarah ke `127.0.0.1:3111` tidak perlu diubah.
