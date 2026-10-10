# Cobe Denim - Hệ Thống Tra Cứu Tồn Kho CTV (Kết Nối MShopKeeper)

Ứng dụng web chuyên biệt dành cho Cộng tác viên (CTV) và Đại lý của **Cobe Denim** tra cứu tồn kho sản phẩm (theo mã, màu sắc, size) tức thì trên điện thoại và máy tính mà **không cần tài khoản MShopKeeper**.

---

## 🌟 Tính Năng Nổi Bật

1. **Tra cứu tức thì & Không cần đăng nhập**:
   - Tìm kiếm theo mã SP (`QJ-101`, `AK-201`), tên sản phẩm, danh mục, màu sắc, size.
   - Hỗ trợ tìm kiếm **tiếng Việt không dấu** (ví dụ: gõ `quan jean` tìm ra ngay `Quần Jean`).
2. **Hình ảnh sản phẩm sắc nét**:
   - Hiển thị ảnh thực tế cho từng mẫu.
   - Bấm vào ảnh để **phóng to (Lightbox)** xem chi tiết chất vải, form dáng và **tải ảnh về máy** để gửi cho khách hàng.
3. **Ma trận tồn kho theo Màu & Size**:
   - Hiển thị trực quan từng phân loại:
     - 🟢 **Còn hàng**: Số lượng sẵn sàng.
     - 🟡 **Sắp hết**: Cảnh báo khi còn dưới 3 chiếc.
     - 🔴 **Hết hàng**: Đánh dấu rõ ràng tránh tư vấn nhầm.
4. **Công cụ hỗ trợ chốt đơn cho CTV**:
   - **Sao chép mã SP** bằng 1 chạm.
   - **Sao chép báo tồn tự động**: Bấm nút "💬 Sao chép báo khách" để tạo ngay đoạn tin nhắn mẫu format đẹp gửi Zalo/Messenger:
     ```text
     👖 Cobe Denim - Quần Jean Suông Rách Gối Cá Tính Cobe Denim (Mã: QJ-102)
     💵 Giá bán: 420.000đ
     📦 Báo tồn kho chi tiết:
     • Xanh Nhạt Wash: [S: còn 6, M: còn 11, L: Hết]
     • Đen Khói: [S: còn 3, M: còn 7, L: còn 2]
     ```
   - **Ẩn/Hiện giá CTV**: Nút 👁️ trên thanh tiêu đề giúp ẩn giá sỉ/CTV khi bạn đang mở web trước mặt khách hàng.
5. **Cơ chế đồng bộ dữ liệu MShopKeeper**:
   - Hỗ trợ gọi API trực tiếp với Access Token / Cookie từ `cobedenim.mshopkeeper.vn`.
   - Nút **"Đồng bộ tức thì"** trên web giúp cập nhật kho mới nhất chỉ sau 1 giây.
   - Hỗ trợ nhập trực tiếp dữ liệu tồn kho bằng JSON.

---

## 🚀 Hướng Dẫn Chạy Tại Máy Tính (Local)

Hệ thống hiện đang chạy trên máy tính của bạn tại cổng 3000:

1. Mở trình duyệt web (Chrome, Cốc Cốc, Safari, Edge...).
2. Truy cập vào đường dẫn:
   ```text
   http://localhost:3000
   ```
3. Nếu bạn muốn khởi động lại hệ thống sau này:
   ```bash
   npm start
   ```

---

## ☁️ Hướng Dẫn Deploy Lên Mạng MIỄN PHÍ 100% (Vercel)

Dự án đã được cấu hình sẵn file `vercel.json` để bạn có thể đưa lên mạng cho CTV truy cập từ bất kỳ đâu (0đ trọn đời):

### Bước 1: Đưa code lên GitHub
1. Tạo một repository mới trên [GitHub.com](https://github.com) (chọn chế độ Private hoặc Public).
2. Mở terminal tại thư mục này và chạy:
   ```bash
   git init
   git add .
   git commit -m "Cobe Denim CTV Inventory Web App"
   git branch -M main
   git remote add origin https://github.com/<tai-khoan-cua-ban>/tra-cuu-misa.git
   git push -u origin main
   ```

### Bước 2: Đăng nhập Vercel & Deploy (1 phút)
1. Truy cập [vercel.com](https://vercel.com) và đăng nhập bằng tài khoản GitHub.
2. Bấm nút **"Add New..."** -> chọn **"Project"**.
3. Chọn repository `tra-cuu-misa` vừa tạo và bấm **Deploy**.
4. Sau khoảng 30 giây, Vercel sẽ cấp cho bạn một đường link miễn phí dạng:
   ```text
   https://cobe-denim-kho.vercel.app
   ```
   *(Bạn có thể gửi link này cho toàn bộ CTV sử dụng ngay trên điện thoại)*.

---

## 🔄 Tự Động Đồng Bộ Kho MShopKeeper Định Kỳ (GitHub Actions Cron)

Để hệ thống tự động đồng bộ tồn kho mỗi 30 phút hoặc 1 tiếng từ MShopKeeper mà không cần bạn làm thủ công:
- Tạo file `.github/workflows/sync-inventory.yml` để gọi endpoint `/api/sync/mshopkeeper`.
- Định kỳ theo cronjob hoàn toàn miễn phí trong gói GitHub Free Tier (2,000 phút/tháng).
