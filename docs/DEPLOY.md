# 部署指南

Wars on Paper 是零构建项目：Node.js 静态文件服务 + 同端口 WebSocket 房间服务，
生产环境只需要 Node.js 20+ 与 `ws` 依赖。

## 本地 / 单机服务器

```bash
npm install
npm run server          # 默认 http://127.0.0.1:8787
PORT=8080 HOST=0.0.0.0 npm run server
```

- `GET /healthz` 返回 `{ ok, version, rooms, players }`，可用于探活。
- 开发时用 `npm run dev`（带热重载）。

## 反向代理（Nginx，含 WebSocket）

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

## systemd

```ini
[Unit]
Description=Wars on Paper
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/wars-on-paper
Environment=PORT=8787 HOST=127.0.0.1
ExecStart=/usr/bin/node src/server/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Docker

```bash
docker build -t wars-on-paper .
docker run -d --name wars-on-paper -p 8787:8787 wars-on-paper
```

## 部署注意事项

- 房间状态在**进程内存**中：默认请只跑单实例；若要多实例，需要共享房间状态或用粘性会话（WebSocket 连接必须落到同一实例）。
- 静态资源无需构建；更新代码后重启进程即可。
- 公网部署需要你自己的域名/服务器或平台账号（本仓库只包含部署脚本与配置示例）。
