map $sent_http_content_type $expires {
    "text/html"                 epoch;
    "text/html; charset=utf-8"  epoch;
    default                     off;
}

# Shared DNS resolver and upstream hostname for rura proxy targets.
resolver 1.1.1.1 8.8.8.8 valid=30s ipv6=off;
resolver_timeout 5s;
map $host $rura_upstream_host {
    default rura.wemeweb.com;
}

# Wildcard subdomains -> /var/www/<host>/current
server {
    listen 80;
    server_name *.wemeweb.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;

    server_name *.wemeweb.com;

    root /var/www/$host/current;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/wemeweb.com/wildcard-error.log;
    access_log /var/log/nginx/wemeweb.com/wildcard-access.log;

    # Gzip
    include /etc/nginx/includes/gzip.conf;

    location / {
        try_files $uri $uri/ =404;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}


server {
    listen 80;
    listen 443 ssl;
    http2 on;
    
    server_name wemeweb.com;

    root /var/www/wemeweb.com/;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/wemeweb.com/error.log;
    access_log /var/log/nginx/wemeweb.com/access.log;
    
    # Gzip
    include /etc/nginx/includes/gzip.conf;

    # redirect server error pages to the static page /50x.html
    #
    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}

# API
server {
  listen 443 ssl;
  http2 on;
  server_name api.wemeweb.com;
  client_max_body_size 100M;

  # SSL
  ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

  error_log  /var/log/nginx/api.wemeweb.com/error.log;
  access_log /var/log/nginx/api.wemeweb.com/access.log;
  
  # Gzip
  include /etc/nginx/includes/gzip.conf;
  
  # redirect server error pages to the static page /50x.html
  #
  error_page   500 502 503 504  /50x.html;
  location = /50x.html {
      root   /usr/share/nginx/html;
  }

  location /graphql {
    proxy_pass https://$rura_upstream_host/graphql;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
  }
}

# n8n
server {
    listen 443 ssl;
    http2 on;
    
    server_name n8n.wemeweb.com;
    client_max_body_size 50M;

    root /var/www/wemeweb.com/;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/wemeweb.com/error.log;
    access_log /var/log/nginx/wemeweb.com/access.log;
    
    # Gzip
    include /etc/nginx/includes/gzip.conf;

    # redirect server error pages to the static page /50x.html
    #
    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }

    location / {  


        proxy_pass http://localhost:5678;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;


        #   expires $expires;

        #   # Set the proxy pass to the n8n application
        #   proxy_pass                          http://localhost:5678;

        #   proxy_http_version 1.1;
        #   proxy_set_header Upgrade $http_upgrade;
        #   proxy_set_header Connection 'upgrade';
        #   proxy_set_header Host n8n.wemeweb.com;
        #   proxy_set_header Origin https://n8n.wemeweb.com;
        #   proxy_cache_bypass $http_upgrade;
        #   proxy_ssl off;
        #   proxy_ssl_verify off;


        # # Allow cors
        # add_header Access-Control-Allow-Origin *;
        # add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
        # add_header Access-Control-Allow-Headers 'Origin, X-Requested-With, Content-Type, Accept, Authorization';
        # add_header Access-Control-Allow-Credentials true;

          






      }

}

# Portainer
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name portainer.wemeweb.com;

    client_max_body_size 50m;

    charset utf-8;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/portainer.wemeweb.com/error.log;
    access_log /var/log/nginx/portainer.wemeweb.com/access.log;

    # Gzip
    include /etc/nginx/includes/gzip.conf;

    

    location / {  
        expires $expires;

        proxy_redirect                      off;
        proxy_set_header Host               $host;
        proxy_set_header X-Real-IP          $remote_addr;
        proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto  $scheme;
        proxy_read_timeout                  1m;
        proxy_connect_timeout               1m;

        # Set the address to Node.js, which `node:3000` is a service name and port from `docker-compose.yml`
        proxy_pass                          https://localhost:9443;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Wiz Shopping
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name wiz.wemeweb.com;

    client_max_body_size 50m;

    charset utf-8;

    # root /var/www/wiz.shopping/current/.output/public;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;
		
    error_log  /var/log/nginx/wiz.shopping/error.log;
    access_log /var/log/nginx/wiz.shopping/access.log;

    # Gzip
    include /etc/nginx/includes/gzip.conf;

    

    location / {  
        expires $expires;

        proxy_redirect                      off;
        proxy_set_header Host               $host;
        proxy_set_header X-Real-IP          $remote_addr;
        proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto  $scheme;
        proxy_read_timeout                  1m;
        proxy_connect_timeout               1m;

        # Set the address to Node.js, which `node:3000` is a service name and port from `docker-compose.yml`
        proxy_pass                          http://localhost:3000;
    }
}

# Storage
server {
	listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name storage.wemeweb.com;

    # SSL
    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    index index.php;
    error_log  /var/log/nginx/storage-error.log;
    access_log /var/log/nginx/storage-access.log;

    # Gzip
    include /etc/nginx/includes/gzip.conf;

    # Allow CORS for domain name
    if ($http_origin ~* "^(https?://)?(.*\.)?wemeweb\.com$") {
      set $cors "$http_origin";
    }

    location / {
        # Need this to resolve allow CORS blocking and pre-flight
        if ($request_method = 'OPTIONS') {
            add_header 'Access-Control-Allow-Origin' '$cors';
            add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS';
            # Custom headers and headers various browsers *should* be OK with but aren't
            add_header 'Access-Control-Allow-Headers' 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range';
            # Tell client that this pre-flight info is valid for 20 days
            add_header 'Access-Control-Max-Age' 1728000;
            add_header 'Content-Type' 'text/plain; charset=utf-8';
            add_header 'Content-Length' 0;
            return 204;
        }

        # Proxy to GraphQL Server
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_pass https://$rura_upstream_host;
        proxy_ssl_server_name on;
    }
}

# Dozzle
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name dozzle.wemeweb.com;

    client_max_body_size 50m;

    charset utf-8;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/dozzle.wemeweb.com/error.log;
    access_log /var/log/nginx/dozzle.wemeweb.com/access.log;

    # Gzip
    include /etc/nginx/includes/gzip.conf;

    

    location / {  
        expires $expires;

        proxy_redirect                      off;
        proxy_set_header Host               $host;
        proxy_set_header X-Real-IP          $remote_addr;
        proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto  $scheme;
        proxy_read_timeout                  1m;
        proxy_connect_timeout               1m;

        # Set the address to service and port from `docker-compose.yml`
        proxy_pass                          http://localhost:7788;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# IGUpload
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    
    server_name igupload.wemeweb.com;

    client_max_body_size 10M;

    root /var/www/igupload.wemeweb.com/current/;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/igupload.wemeweb.com/error.log;
    access_log /var/log/nginx/igupload.wemeweb.com/access.log;
    
    # Gzip
    include /etc/nginx/includes/gzip.conf;

    # redirect server error pages to the static page /50x.html
    #
    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
    
    location /uploads/ {
        alias /var/www/igupload.wemeweb.com/current/uploads/;
    }

    location / {  
        proxy_pass http://localhost:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;


        #   expires $expires;

        #   # Set the proxy pass to the n8n application
        #   proxy_pass                          http://localhost:5678;

        #   proxy_http_version 1.1;
        #   proxy_set_header Upgrade $http_upgrade;
        #   proxy_set_header Connection 'upgrade';
        #   proxy_set_header Host n8n.wemeweb.com;
        #   proxy_set_header Origin https://n8n.wemeweb.com;
        #   proxy_cache_bypass $http_upgrade;
        #   proxy_ssl off;
        #   proxy_ssl_verify off;

      }

}

# Playda
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name playda.wemeweb.com;

    client_max_body_size 50m;

    charset utf-8;

    ssl_certificate /etc/letsencrypt/live/wemeweb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wemeweb.com/privkey.pem;

    error_log  /var/log/nginx/wemeweb.com/playda-error.log;
    access_log /var/log/nginx/wemeweb.com/playda-access.log;

    # Gzip
    include /etc/nginx/includes/gzip.conf;

    

    location / {  
        expires $expires;

        proxy_redirect                      off;
        proxy_set_header Host               $host;
        proxy_set_header X-Real-IP          $remote_addr;
        proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto  $scheme;
        proxy_read_timeout                  1m;
        proxy_connect_timeout               1m;

        # Set the address to Node.js, which `node:3001` is a service name and port from `docker-compose.yml`
        proxy_pass                          http://localhost:3001;
    }
}