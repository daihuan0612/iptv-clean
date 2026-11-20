# iptv-clean

把第三方聚合 IPTV 表（`live.zbds.top`）清洗成**只要的、真的能播的**那几十个台，
每 6 小时由 GitHub Actions 自动跑一次，结果提交回本仓库的 `out/`。

消费方直接读 `out/channels.json`（公开地址、无需鉴权），把通过验收的台挂到自己页面上；
**没通过的不显示**（不会一直挂着一个播不了的台标）。

## 输出

| 文件 | 用途 | 说明 |
|---|---|---|
| `out/channels.json` | 给程序读 | 三档名单：验通 / 待定 / 没通过，字段见下 |
| `out/playlist.m3u` | 盒子 / 播放器 | **只含验通**的干净清单，可以直接导入 |
| `out/report.md` | 给人看 | 本轮逐台结果：哪些通过、哪些没通过、为什么 |
| `state/history.json` | 脚本自己 | 每台连续通过 / 失败次数 |

`out/channels.json`：

```json
{
  "generated_at": "…",
  "count": 5,               // 验通台数
  "unverified_count": 4,    // 待定台数
  "channels":   [ { "slug": "hnws", "name": "湖南卫视", "group": "卫视", "url": "…", "host": "…", "cors": true, "live_ok": true, "frame_diff": 41.2 } ],
  "unverified": [ { "slug": "scws", "name": "四川卫视", "group": "卫视", "url": "…", "why": "fetch failed" } ],
  "missing":    [ { "slug": "cctv1", "name": "CCTV-1 综合", "why": "表里没有这一台" } ]
}
```

三档的意思：

| 档 | 含义 | 建议怎么用 |
|---|---|---|
| `channels` | 验通了：清单在滚、分片是真视频、https、带 CORS、不是占位 | 上架，播放器直连 |
| `unverified` | 结构看着正常，只是**这台验收机**（境外）连不上 —— 不代表终端连不上 | 也可以上架；播放失败时切到别的备用源 |
| `missing` | 假源 / 结构硬伤 / 表里没有 | 不显示 |

## 数据源

- `https://live.zbds.top/tv/iptv4.m3u`（339 台，每 4~6 小时更新，无 token、无 Referer）
- 备用解析：`https://live.zbds.top/tv/iptv4.txt`（`,#genre#` 分组）

表是第三方聚合的，**地址天天变**，所以：不硬编码地址、每轮重新拉、拉失败就保留上一轮结果
（`channels.json` 里标 `"stale": true`），不要把名单清空。

**只探白名单里那些台**，绝不遍历全表 339 条；并发压到 3，探测之间还有随机间隔 ——
别把人家源站打急。

## 验收门槛

1. 清单能取到，且能解析出至少 2 个分片；
2. 首个分片取得到（200 / 206）；
3. 是真视频：`Content-Type` 是 `video/MP2T`，或首字节是 TS 同步字节 `0x47`，
   或加密流（`#EXT-X-KEY`）且取到 >= 100 KB；
4. 分片走 **https**（网页是 https，分片是明文 http 会被浏览器按混合内容拦掉）；
5. 分片带 **CORS 头**（`Access-Control-Allow-Origin`）：服务器端能取、浏览器拉不了照样黑屏；
6. 不在 `denylist.json` 里（台名对不上 / 已知卡顿 / 已知假源，人工维护）；
7. **不是占位画面**（挂掉时不是报错、而是循环播一段台标 / 二维码，这种情况看着完全正常）：
   - 清单带 `#EXT-X-ENDLIST` ⇒ 点播式固定片段，判死；
   - 清单被跳转到带 `nosignal` / `logo` / `qrcode` / `placeholder` 的地址 ⇒ 判死；
   - **隔 30 秒再取一次清单**：`MEDIA-SEQUENCE` 和分片列表都没动、窗口 < 60 秒 ⇒ 冻结或循环，判死；
   - **同一清单里两个不同分片内容完全相同**（前 128 KB 指纹一致）⇒ 在循环播同一段，判死；
   - **两个分片的首帧几乎一样**（缩成 32×32 灰度比差 < 2/255，需要 ffmpeg）⇒ 静止画面，判死。

明确排除：返回 HTML/JSON 页、`.jpg` / `.bmp` 切片、`.mp4` 文件、地址里带 `nosignal`。

## 白名单

`wanted.json` 里是真正要的台（当前 56 个：央视 16 + 卫视 32 + 体育 8），
`match` 是表里可能出现的各种写法（`CCTV-1` / `CCTV1` / `CCTV1综合` 等）。
表里没有的台、或者没验过的台，只是不进 `channels.json`，不影响别的台。

体育台（`cctv5` / `cctv5p` / 广东体育 / 五星体育 / 劲爆体育 / 纬来 / 精品 / 咪咕 / 新视觉 / 欧洲足球）
一直留在白名单里：哪天表里出现且验通，就自动上架；哪天没了，自动下架。不用改代码。

## 手动跑

仓库页 -> Actions -> `refresh` -> Run workflow。
本地跑（需要 Node 18+）：

```bash
node scripts/verify.mjs
```

## 参数

脚本顶部常量（也可用环境变量覆盖）：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `PROBE_TIMEOUT_MS` | 8000 | 单次探测超时 |
| `PROBE_CONCURRENCY` | 4 | 同时探测几个台（Actions 里压到 3） |
| `SEG_SAMPLE_BYTES` | 262144 | 首片取样字节数（Range） |
| `MAX_CANDIDATES` | 3 | 每台最多试几条地址 |
| `RECHECK_WAIT_MS` | 30000 | 复查间隔（抓"不滚动的循环占位"） |
| `FRAME_CHECK` | 关 | `1` = 开逐帧比对（需要 ffmpeg） |
| `POLITE_MIN_MS` / `POLITE_MAX_MS` | 150 / 450 | 两次探测之间随机停多久 |
| `PROBE_ORIGIN` | `https://example.com` | 探测分片时带的 Origin（真实播放页域名从环境变量传，不写进仓库） |

## 不做的事

- 不代理视频字节（只产出名单，播放器自己连源）；
- 不猜台名（对不上就进 `denylist.json`，宁可少一个台，不要张冠李戴）；
- 不留任何 token / 密钥（本仓库是公开仓库，里面只有清洗结果）。
