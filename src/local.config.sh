# === FNS 笔记服务配置 ===
export FNS_BASE_URL='http://127.0.0.1:9000'
export FNS_TOKEN='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjEsIm5pY2tuYW1lIjoiZ3JhZ3JhMDIwMiIsImlwIjoiMTIxLjIzOS4xNzkuMzgiLCJpc3MiOiJmYXN0LW5vdGUtc3luYy1zZXJ2aWNlIiwic3ViIjoidXNlci10b2tlbiIsImV4cCI6MTgxMDM5Nzc1NSwibmJmIjoxNzc4ODYxNzU1LCJpYXQiOjE3Nzg4NjE3NTUsImp0aSI6IjEifQ.3tFAeIRj2n_IltVrQHTtzCcIFDsu_nYRC8QvUCd2tPI'
export FNS_DEFAULT_VAULT='Life-Learing'
export FNS_TASKS_PREFIX='000 PARA/020 Areas/AI任务/'

# === 时区 ===
export TZ='Asia/Shanghai'
export APP_TIME_ZONE='Asia/Shanghai'

# === Claude / Anthropic API 配置（DeepSeek 端点）===
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export ANTHROPIC_AUTH_TOKEN='sk-8e32b8c4dcf14c2ab84f759cd89e17a7'
export ANTHROPIC_MODEL='deepseek-v4-pro'
export ANTHROPIC_MODELS='deepseek-v4-pro,deepseek-v4-flash'

# === Web 服务器配置 ===
export WEB_TERMINAL_HOST='0.0.0.0'
export WEB_TERMINAL_PORT='8000'
export JOB_HISTORY_LIMIT='20'

# === 登录认证（不设置则无需密码） ===
export WEB_ACCESS_PASSWORD_HASH='2123a752378c0a532a04ea9870d15f5d:192256f511bdf7746540b6ead18e7a64994b08950be1305630475657db3580569eaffd8db2665e67ca8600753e613d9c63aafe24e59e30fda8e05b8f63e5052f'
export COOKIE_SECRET='1fe0c37da0bb3606eb3d83c846c2d28b09e1f7400ef4323c19ee4662f5c71aaf'
export SESSION_MAX_AGE_MS='604800000'
