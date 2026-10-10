# QUY TẮC PHÁT TRIỂN & DEPLOY DỰ ÁN TRA CỨU TỒN KHO COBE DENIM
> **Dành cho mọi Agent / Mô hình AI khi tiếp quản dự án này**

---

## 1. Kiến Trúc Dự Án (Dual-Mode Hybrid Architecture)
Dự án được xây dựng theo mô hình **Lai (Hybrid 2-trong-1)**:
* **Chế độ 1 - Local Node.js Server (`server.js`):** Chạy tại máy tính cửa hàng trong giờ hành chính để tự động đọc Access Token từ Chrome/Edge LevelDB và đồng bộ tồn kho từ MShopKeeper MISA mỗi 2 tiếng.
* **Chế độ 2 - Cloudflare Pages & Functions (Online 24/7):** Phục vụ giao diện tra cứu và API cho CTV, khách hàng và đối tác xuyên đêm 24/7 kể cả khi máy tính shop đã tắt.

---

## 2. QUY TẮC BẮT BUỘC TRƯỚC KHI DEPLOY LÊN CLOUDFLARE (PRE-FLIGHT RULES)

### ⚠️ Quy tắc 1: CẤM deploy trực tiếp khi chưa kiểm tra bằng `wrangler`
* Môi trường Cloudflare Pages & Functions chạy trên **V8 Edge Runtime (Workerd)**, KHÔNG PHẢI môi trường Node.js truyền thống.
* **Bắt buộc:** Trước khi đẩy code lên GitHub để Cloudflare build, AI agent PHẢI chạy lệnh kiểm thử giả lập môi trường Edge cục bộ:
  ```bash
  npx wrangler pages dev public
  ```
* Nếu lệnh trên chạy không có lỗi và các API phản hồi 200 OK thì mới được phép commit và deploy.

### ⚠️ Quy tắc 2: Không dùng thư viện cấm trong thư mục `functions/`
* Trong thư mục `functions/` (Cloudflare Pages Functions):
  * **TUYỆT ĐỐI KHÔNG DÙNG:** `fs`, `child_process`, `net`, `http`, `cluster`, `path.resolve` (vì Edge không có hệ điều hành).
  * **BẮT BUỘC DÙNG:** Chuẩn Web API (`fetch`, `Request`, `Response`, `crypto.subtle` hoặc Web Crypto APIs).

### ⚠️ Quy tắc 3: Bảo vệ an toàn bí mật (Zero-Secret Leaks)
* Các file sau **BẮT BUỘC PHẢI LUÔN NẰM TRONG `.gitignore`** và không bao giờ được commit lên GitHub:
  * `data/sync-config.json` (chứa Token thật MShopKeeper và BranchID)
  * `data/api-keys.json` (chứa Secret Keys thương mại thật)
* Chỉ được commit các file mẫu: `data/sync-config.example.json` và `data/api-keys.example.json`.

### ⚠️ Quy tắc 4: Bảo tồn các lớp bảo mật đã thiết lập
Khi chỉnh sửa code hoặc tạo route mới, AI agent không được làm mất các tính năng an toàn sau:
1. **Public Web API (`/api/products`):**
   * Giữ Rate Limit (180 req/phút/IP).
   * Giữ bộ lọc phát hiện bot tự động (`botDetectionMiddleware`) chặn `python-requests`, `curl`, `scrapy` gọi cào thô.
   * Giữ trần an toàn tối đa 100 sản phẩm/trang.
2. **Commercial API (`/api/v1/products`):**
   * Bắt buộc kiểm tra chữ ký số **HMAC-SHA256** qua 4 headers: `x-api-key`, `x-timestamp`, `x-nonce`, `x-signature`.
   * So sánh chữ ký bằng hàm hằng số thời gian (`crypto.timingSafeEqual` hoặc `timingSafeEqual`) chống Timing Attack.
   * Đảm bảo `TTL Nonce (120s) >= Timestamp Window (60s)` chống Replay Attack.
   * Chuẩn hóa đường dẫn: `rawPath.toLowerCase().replace(/\/+$/, '')`.
   * Giới hạn an toàn tối đa 50 sản phẩm/lượt gọi.

---

## 3. Cấu Hình Chuẩn Khi Deploy Cloudflare Pages
* **Framework preset:** `None`
* **Build command:** `(để trống)`
* **Build output directory:** `public`
* **Root directory:** `/`

---

## 4. Danh Sách Lệnh Hữu Ích
* **Chạy server local Node.js:** `npm start` hoặc `node server.js`
* **Test bảo mật tự động:** `node scratch/test_security.js`
* **Chạy giả lập Cloudflare Edge:** `npx wrangler pages dev public`
* **Deploy tự động:** Chỉ cần `git push origin main` (Cloudflare Pages tự động build từ nhánh `main`).
