# 台北飯店資料管理

使用 MongoDB Atlas 儲存資料，並以單一管理密碼登入。支援新增、修改、刪除與搜尋。

## 本機啟動

1. 複製 `.env.example` 為 `.env`，填入自己的 Atlas 連線字串、管理密碼與工作階段密鑰。
2. 將 `.env` 載入環境變數後執行 `npm install` 與 `npm start`。
3. 第一次匯入 Excel 時執行 `npm run import`。

## 部署必要環境變數

- `MONGODB_URI`
- `MONGODB_DB`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `ALLOWED_ORIGIN`（正式網站完整網址，例如 `https://example.com`）

請勿把 `.env`、MongoDB 密碼或管理密碼提交到 GitHub。
