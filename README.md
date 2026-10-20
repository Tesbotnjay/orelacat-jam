# OrelaCat Jam server

Server Listen Together (Go) untuk OrelaCat. Sumber: BitChord v1.8.1 `backend/`
(GPL-3.0). Perubahan: nama modul, skema deep link `orelacat://`, teks halaman
invite.

## Jalankan lokal

```bash
go run .
# -> http://127.0.0.1:8080
curl localhost:8080/healthz
```

## Deploy gratis di Render

1. Push repo ini ke GitHub (`Tesbotnjay/orelacat-jam`).
2. Render Dashboard -> New -> Web Service -> connect repo.
3. Root Directory: `.` | Runtime: **Go** | Plan: **Free** | Region: Singapore
4. Build Command: `go build -o server .`
5. Start Command: `./server`
6. Health Check Path: `/healthz`
7. Deploy, lalu salin URL-nya (contoh `https://orelacat-jam.onrender.com`).
8. Isi `LISTEN_TOGETHER_SERVER=<URL>` di `local.properties` repo aplikasi,
   build ulang APK.

Free plan tidur setelah 15 menit idle; permintaan pertama bangun ~30 detik.
Parties disimpan di memori, jadi restart = party hilang. Itu perilaku asli.

## Endpoint

`GET /healthz` `GET /api/time` `POST /api/parties` `POST /api/parties/{code}/join`
`GET /api/parties/{code}` `GET /api/parties/{code}/preview`
`POST /api/parties/{code}/leave` `POST /api/presence` `GET /api/stats/live`
`GET /invite/{code}` `GET /ws/parties/{code}`

## Lisensi

GPL-3.0. Lihat `LICENSE` (salinan dari BitChord).
