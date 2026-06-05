# autoObsidian

`autoObsidian` 是一个把 FNS 笔记服务包装成手机可用网页的项目。

## 能做什么

- 切换 vault
- 搜索笔记
- 打开笔记查看内容
- 编辑并保存笔记
- 追加内容到末尾
- 插入内容到开头
- 替换选中的文本

## 启动前准备

先编辑 `local.config.sh`，把 `FNS_TOKEN` 换成你的真实 token。

## 安装

```bash
./install.sh
```

或者直接确认本地配置：

```bash
cp local.config.sh local.config.sh.bak
```

## 启动网页

```bash
npm run web
```

然后在手机或电脑浏览器里打开：

```text
http://<你的电脑局域网IP>:8000
```

如果只在本机测试：

```text
http://127.0.0.1:8000
```

## 先注册 MCP

如果你还要在 Codex 里直接调用工具，再执行：

```bash
codex mcp add fns-local -- python3 /home/Gragra/cloud_make_calender/src/server.py
```

## 注意

- 这个网页会直接连你本机的 FNS 服务
- `FNS_TOKEN` 不要再明文发给别人
- 默认 vault 名字是 `Life-Learing`
- 如果网页空白或提示登录失效，先检查 `local.config.sh` 里的 token 是否有效
