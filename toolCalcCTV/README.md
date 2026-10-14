# Hướng dẫn Cài đặt & Sử dụng Extension: Tra Cứu & Sửa Giá CTV POS

Extension Manifest V3 hỗ trợ tự động hiển thị và cập nhật nhanh giá Cộng Tác Viên (CTV) trực tiếp trên giao diện bán hàng POS (như Sapo POS).

---

## 🚀 1. Hướng dẫn Cài đặt Extension vào Trình duyệt (Chrome / Cốc Cốc / Edge)

1. Mở trình duyệt Chrome hoặc Cốc Cốc, truy cập đường dẫn:
   ```
   chrome://extensions/
   ```
2. Bật công tắc **Developer mode (Chế độ dành cho nhà phát triển)** ở góc trên bên phải.
3. Bấm vào nút **Load unpacked (Tải tiện ích đã giải nén)** ở góc trên bên trái.
4. Chọn thư mục dự án:
   ```
   d:\FPT\project\toolCalcCTV
   ```
5. Tiện ích **"Tra Cứu & Sửa Nhanh Giá CTV POS"** sẽ xuất hiện trên thanh công cụ của trình duyệt.

---

## 🎯 2. Cách Extension Hoạt động

### A. Tự động nhận diện Mã (Mã + Màu, bỏ Size)
- Khi bạn thêm sản phẩm vào đơn (ví dụ mã `DCC01-DE-L`), extension sẽ tự động nhận diện phần **Mã + Màu** là `DCC01-DE` (bỏ size `L`).
- Nhờ vậy, tất cả các size khác như `DCC01-DE-S`, `DCC01-DE-M`, `DCC01-DE-XL` đều **tự động dùng chung giá CTV của mã `DCC01-DE`**.

### B. Hiển thị & Sửa giá trực tiếp trên màn hình POS
1. **Sản phẩm chưa có giá CTV**:
   - Dưới đơn giá sẽ hiện: `CTV: 0 đ` (viền nét đứt màu cam).
   - Click chuột trực tiếp vào số `0` ➔ ô nhập giá sẽ mở ra ngay tại dòng đó ➔ gõ số tiền (VD: `350k` hoặc `350000`) ➔ bấm **`Enter`**.
   - Giá được lưu ngay lập tức và các dòng sản phẩm cùng mã sẽ tự động cập nhật theo.
2. **Sản phẩm đã có giá**:
   - Hiện giá bình thường (VD: `CTV: 350.000 đ`).
3. **Cần cập nhật giá mới**:
   - Click chuột trực tiếp vào số tiền `350.000 đ` ➔ gõ giá mới ➔ bấm **`Enter`** để lưu.
4. **Thanh tổng kết nổi ở góc phải dưới**:
   - Tự động cộng tổng tiền đơn bán POS, tổng tiền CTV và số tiền chênh lệch (lợi nhuận / hoa hồng). Có thể ấn nút thu gọn nếu muốn.

---

## 📊 3. Hỗ trợ Nhập / Xuất bằng File Excel (.xlsx, .xls)

Bấm vào biểu tượng Extension trên thanh công cụ để mở giao diện quản trị:

1. **📥 Nhập File Excel**:
   - Bấm nút **"Nhập File Excel"** và chọn file Excel (`.xlsx` hoặc `.xls`) của bạn.
   - Tự động nhận diện cột Mã/SKU và cột Giá CTV.
   - Tự động lọc bỏ size khi nạp.
2. **📤 Xuất Excel**:
   - Bấm nút **"Xuất Excel"** để tải toàn bộ bảng giá CTV hiện tại về máy tính dưới dạng file `.xlsx`.
3. **📄 File Mẫu**:
   - Tải file Excel mẫu chuẩn 2 cột để tiện điền dữ liệu.
4. **🔍 Tìm kiếm & Thêm/Xóa mã thủ công**:
   - Tra cứu nhanh mã sản phẩm và sửa/xóa từng mã nếu cần.

---

## 🧪 4. Trang Thử nghiệm Demo
Bạn có thể mở trực tiếp file `demo/sapo_pos_demo.html` trên trình duyệt để trải nghiệm thử giao diện mô phỏng Sapo POS và thao tác click sửa giá.
