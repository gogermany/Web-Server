#WeMeWeb Architecture

## Domain
 - WeMeWeb.com - Domain & DNS Using AWS Route 53

## Servers 
### Rūra GraphQL API Server
- 43.210.40.198 - Auto-assigned IP address (It will change if the server is stopped and started again) Plan to use Elastic IP in the future
- AWS EC2 Instance - t4g.small - Region: ap-southeast-7 (Thailand)
- Ubuntu 24.04.4 LTS
- Docker 29.6.2
  - Docker Compose
    - NGINX 1.27.5 - Proxy and Serve Image files across all subdomains - storage.wemeweb.com
    - GraphQL API - api.wemeweb.com (NGINX 443:4000)
    - MongoDB 7.0
    - Dozzle Agent - for monitoring logs containers send to Dozzle on PM2 Apps Server
### PM2 Apps Server
- 43.209.160.58 - Elastic IP
- AWS EC2 Instance - t4g.medium - Region: ap-southeast-7 (Thailand)
- Ubuntu 24.04.5
    - Important paths:
      - /etc/nginx/sites-available - NGINX config files
        - Repository: https://github.com/gogermany/Web-Server
      - /var/www - PM2 apps root directory or Docker compose yml project root directory
        - wemeweb.com
        - n8n.wemeweb.com
        - portainer.wemeweb.com
        - dozzle.wemeweb.com
    - Important files:
      - /etc/nginx/sites-available/wemeweb.com - NGINX config for wemeweb.com

- Docker 29.4.3
  - Docker Compose
    - N8N - n8n.wemeweb.com (NGINX 443:5678)
    - Portainer CE - portainer.wemeweb.com (NGINX 443:9443)
    - Dozzle - dozzle.wemeweb.com (NGINX 443:7788) 
    - Dozzle Bridge PM2 Wiz Logs - Alpine
    - Dozzle Bridge PM2 Playda Logs - Alpine
- PM2 7.1.1
  - Apps
    - Wiz.Shopping (Cluster) wiz.wemeweb.com (NGINX 443:3000) 
        - Repository: https://github.com/gogermany/Wiz
    - Playda (Cluster) - playda.wemeweb.com (NGINX 443:3001)
        - Repository: https://github.com/gogermany/Playda

### Server Security




### Everyday Commands
- NGINX
    - `sudo nginx -t` - Test NGINX configuration
    - `sudo systemctl reload nginx` - Reload NGINX Configuration
    - `sudo systemctl restart nginx` - Restart NGINX service
  
