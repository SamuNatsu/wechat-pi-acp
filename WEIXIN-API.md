# WeChat/Weixin Bot API — Reverse Engineering Report

> Derived from `@tencent-weixin/openclaw-weixin` v2.4.4 source code.  
> This documents the public HTTP API that the plugin talks to — the same API you'd call to build a custom WeChat bot.

---

## 1. Base URLs

| Purpose                      | URL                                     |
| ---------------------------- | --------------------------------------- |
| API base (login + messaging) | `https://ilinkai.weixin.qq.com`         |
| CDN uploads                  | `https://novac2c.cdn.weixin.qq.com/c2c` |

Both are configurable per-account. The QR login flow always uses the fixed `ilinkai.weixin.qq.com` base.

---

## 2. HTTP Headers

### 2.1 QR Login (no auth token yet)

```
Content-Type: application/json
iLink-App-Id: bot
iLink-App-ClientVersion: <uint32>   # e.g. 132098 for plugin v2.4.4
```

### 2.2 Authenticated Requests (after QR login)

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
iLink-App-Id: bot
iLink-App-ClientVersion: <uint32>
SKRouteTag: <route_tag>              # optional, from config
X-WECHAT-UIN: <base64>              # random uint32 → decimal → base64
```

### 2.3 CDN Upload (POST binary)

```
Content-Type: application/octet-stream
```

---

## 3. Client Version Encoding

```
iLink-App-ClientVersion = 0x00MMNNPP
  where MM = major, NN = minor, PP = patch

e.g. "2.4.4" → 0x00020404 = 132100
     "1.0.11" → 0x0001000B = 65547
```

---

## 4. API Endpoints

All paths are relative to the API base. Each response has `ret` (0 = success).

### 4.1 Login Flow

#### POST `ilink/bot/get_bot_qrcode?bot_type=3`

Get a new QR code for login. No auth headers needed.

**Request:**

```json
{
  "local_token_list": ["<existing_token_1>", "<existing_token_2>"]
}
```

Up to 10 previously saved tokens (helps server detect rebinds).

**Response:**

```json
{
  "qrcode": "<qrcode_id_hash>",
  "qrcode_img_content": "https://.../<encoded_qr_url>"
}
```

- `qrcode`: opaque ID used in status polling.
- `qrcode_img_content`: URL to render as QR code in terminal.

#### GET `ilink/bot/get_qrcode_status?qrcode=<id>[&verify_code=<code>]`

Long-poll for QR scan status. Client side: 35s timeout.

**Response states:**

| `status`              | Meaning                     | Action                                                  |
| --------------------- | --------------------------- | ------------------------------------------------------- |
| `wait`                | Not scanned yet             | Re-poll                                                 |
| `scaned`              | Scanned, waiting confirm    | Continue polling                                        |
| `need_verifycode`     | Server wants a numeric code | Read code from user, re-poll with `&verify_code=<code>` |
| `confirmed`           | Login successful            | Extract `bot_token`, save it                            |
| `expired`             | QR expired                  | Fetch new QR                                            |
| `verify_code_blocked` | Too many wrong codes        | Refresh QR                                              |
| `scaned_but_redirect` | IDC redirect                | Switch polling host to `https://<redirect_host>`        |
| `binded_redirect`     | Already bound               | Stop — no re-login needed                               |

**On `confirmed:`**

```json
{
  "status": "confirmed",
  "bot_token": "<bearer_token>",
  "ilink_bot_id": "<hex>@im.bot",
  "baseurl": "https://ilinkai.weixin.qq.com",
  "ilink_user_id": "<hex>@im.wechat"
}
```

**Login lifecycle diagram:**

```
fetchQRCode  →  display QR  →  poll loop
                                   ├─ wait → [1s delay] → loop
                                   ├─ scaned → loop
                                   ├─ need_verifycode → stdin read num → loop
                                   ├─ scaned_but_redirect → switch host → loop
                                   ├─ expired → refresh QR (max 3×) → loop
                                   ├─ verify_code_blocked → refresh QR (max 3×) → loop
                                   └─ confirmed → save token → DONE
```

### 4.2 Messaging

#### POST `ilink/bot/getupdates` — Long-Poll for Inbound Messages

**Request:**

```json
{
  "get_updates_buf": "<base64_or_empty>",
  "base_info": {
    "channel_version": "2.4.4",
    "bot_agent": "OpenClaw"
  }
}
```

- `get_updates_buf`: opaque cursor from previous response. Empty string for first request. Send it back verbatim each poll.

**Response:**

```json
{
  "ret": 0,
  "errcode": 0,
  "errmsg": "",
  "msgs": [
    /* WeixinMessage[] */
  ],
  "get_updates_buf": "<new_cursor_base64>",
  "longpolling_timeout_ms": 35000
}
```

- Server holds the request open until messages arrive or timeout.
- `longpolling_timeout_ms`: server-suggested timeout for the next request.
- `errcode === -14`: session expired — pause all API calls for 60 minutes.

**Error handling:**
| Condition | Action |
|-----------|--------|
| Single API error (`ret != 0`) | Retry after 2s |
| 3 consecutive failures | Backoff 30s |
| Session expired (`-14`) | Pause 60 min |

#### POST `ilink/bot/sendmessage` — Send Outbound Message

**Request:**

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<recipient@im.wechat>",
    "client_id": "openclaw-weixin:<timestamp>-<8hex>",
    "message_type": 2,
    "message_state": 2,
    "item_list": [{ "type": 1, "text_item": { "text": "Hello world" } }],
    "context_token": "<token_from_last_received_msg>",
    "run_id": "<uuid>"
  },
  "base_info": {
    "channel_version": "2.4.4",
    "bot_agent": "OpenClaw"
  }
}
```

- `context_token`: opaque token from the last received `WeixinMessage`. Echo it verbatim.
- `client_id`: unique per-message ID, format `prefix:timestamp-hex`.

#### POST `ilink/bot/sendtyping` — Typing Indicator

**Request:**

```json
{
  "ilink_user_id": "<user@im.wechat>",
  "typing_ticket": "<base64_from_getconfig>",
  "status": 1,
  "base_info": { "channel_version": "2.4.4", "bot_agent": "OpenClaw" }
}
```

- `status`: `1` = start typing, `2` = cancel typing.
- `typing_ticket`: obtained from `getconfig`.

#### POST `ilink/bot/getconfig` — Fetch Bot Config

**Request:**

```json
{
  "ilink_user_id": "<user@im.wechat>",
  "context_token": "<optional>",
  "base_info": { "channel_version": "2.4.4", "bot_agent": "OpenClaw" }
}
```

**Response:**

```json
{
  "ret": 0,
  "typing_ticket": "<base64_ticket>"
}
```

The `typing_ticket` is cached per-user for 24h (randomized refresh).

#### POST `ilink/bot/msg/notifystart` — Notify Server of Client Start

```json
{ "base_info": { "channel_version": "2.4.4", "bot_agent": "OpenClaw" } }
```

Response: `{ "ret": 0, "errmsg": "" }`

#### POST `ilink/bot/msg/notifystop` — Notify Server of Client Stop

```json
{ "base_info": { "channel_version": "2.4.4", "bot_agent": "OpenClaw" } }
```

Response: `{ "ret": 0, "errmsg": "" }`

### 4.3 CDN Upload

#### POST `ilink/bot/getuploadurl` — Get Pre-Signed CDN Upload URL

**Request:**

```json
{
  "filekey": "<16_byte_hex>",
  "media_type": 1,
  "to_user_id": "<recipient@im.wechat>",
  "rawsize": 12345,
  "rawfilemd5": "<md5_hex>",
  "filesize": 12352,
  "no_need_thumb": true,
  "aeskey": "<32_char_hex>",
  "base_info": { "channel_version": "2.4.4", "bot_agent": "OpenClaw" }
}
```

- `media_type`: `1` = IMAGE, `2` = VIDEO, `3` = FILE, `4` = VOICE
- `rawsize`: plaintext size in bytes
- `rawfilemd5`: MD5 hash of plaintext
- `filesize`: ciphertext size (AES-128-ECB PKCS7-padded: `ceil((rawsize+1)/16)*16`)
- `aeskey`: 16-byte AES key, hex-encoded (32 chars)
- `filekey`: 16 random bytes, hex-encoded (32 chars)

**Response:**

```json
{
  "upload_param": "<encrypted_params>",
  "upload_full_url": "https://novac2c.cdn.weixin.qq.com/c2c/upload?..."
}
```

#### CDN Upload (POST binary)

After `getuploadurl`:

1. Encrypt plaintext with `AES-128-ECB` using the generated key (PKCS7 padding, IV = null).
2. POST ciphertext as `application/octet-stream` to the CDN URL.
3. If `upload_full_url` is provided, POST directly to it.
4. Otherwise, build URL: `{cdnBaseUrl}/upload?encrypted_query_param={upload_param}&filekey={filekey}`
5. Extract `x-encrypted-param` from response headers — this is the download param.

#### CDN Download (inbound media)

1. Parse AES key from `CDNMedia.aes_key` (base64 → raw 16 bytes, or base64 → hex string → bytes).
2. If `full_url` provided, GET it directly.
3. Otherwise, GET: `{cdnBaseUrl}/download?encrypted_query_param={encrypt_query_param}`
4. Decrypt response with AES-128-ECB.

#### Full Upload Flow

```
read file → MD5(plaintext) → aeskey = randomBytes(16)
→ filekey = randomBytes(16).hex
→ POST getuploadurl (filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, aeskey)
→ encrypt plaintext with AES-128-ECB(aeskey)
→ POST ciphertext to CDN URL
→ extract x-encrypted-param from response headers
→ construct message item with encrypt_query_param + aes_key(base64)
→ POST sendmessage
```

---

## 5. Data Types

### 5.1 Enums

| Enum              | Values                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `MessageType`     | 0=NONE, 1=USER, 2=BOT                                                                      |
| `MessageState`    | 0=NEW, 1=GENERATING, 2=FINISH                                                              |
| `MessageItemType` | 0=NONE, 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO, 11=TOOL_CALL_START, 12=TOOL_CALL_RESULT |
| `UploadMediaType` | 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE                                                          |
| `TypingStatus`    | 1=TYPING, 2=CANCEL                                                                         |

### 5.2 WeixinMessage

```typescript
{
  seq?: number;
  message_id?: number;
  from_user_id?: string;    // "<hex>@im.bot" or "<hex>@im.wechat"
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;     // MessageType
  message_state?: number;    // MessageState
  item_list?: MessageItem[];
  context_token?: string;    // MUST echo in reply
  run_id?: string;           // UUID grouping related messages
}
```

### 5.3 MessageItem

```typescript
{
  type?: number;             // MessageItemType
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: { text: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  tool_call_start_item?: { tool_name: string; tool_call_id: string };
  tool_call_result_item?: { tool_name: string; tool_call_id: string; status: string };
}
```

### 5.4 ImageItem

```typescript
{
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;          // hex AES key (preferred for inbound decryption)
  mid_size?: number;        // ciphertext size
  hd_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}
```

### 5.5 CDNMedia

```typescript
{
  encrypt_query_param?: string;  // CDN download param
  aes_key?: string;              // base64-encoded AES-128 key
  encrypt_type?: number;         // 0=encrypt fileid only, 1=encrypt thumbnail/mid info
  full_url?: string;             // server-provided full download URL
}
```

### 5.6 VideoItem / FileItem / VoiceItem

```typescript
// VideoItem
{ media?: CDNMedia; video_size?: number; play_length?: number; video_md5?: string; thumb_media?: CDNMedia; ... }

// FileItem
{ media?: CDNMedia; file_name?: string; md5?: string; len?: string; }  // len = plaintext size as string

// VoiceItem
{ media?: CDNMedia; encode_type?: number; bits_per_sample?: number; sample_rate?: number; playtime?: number; text?: string; }
// encode_type: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex
```

---

## 6. Complete Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. REGISTRATION (boot)                                            │
│    index.ts → register() → api.registerChannel({ plugin })        │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ 2. QR LOGIN (one-time)                                            │
│    POST get_bot_qrcode?bot_type=3                                 │
│    → display QR in terminal                                       │
│    → poll get_qrcode_status (35s timeout, 1s interval)            │
│    → user scans on phone                                          │
│    → [optional verification code]                                 │
│    → confirmed: save bot_token, baseurl, ilink_bot_id, user_id    │
│    → persist to disk                                              │
│    → register scanning user in allowlist (pairing)                │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ 3. GATEWAY START (per-account)                                    │
│    restoreContextTokens() from disk                                │
│    POST notifystart                                               │
│    enter long-poll loop                                           │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ 4. MESSAGE RECEPTION LOOP                                         │
│    while !aborted:                                                │
│      POST getupdates(get_updates_buf, timeout)                    │
│      ┌─ on success:                                               │
│      │   save new get_updates_buf to disk                         │
│      │   for each WeixinMessage:                                  │
│      │     check slash commands                                   │
│      │     download + decrypt CDN media (if any)                  │
│      │     resolve sender authorization (allowFrom)               │
│      │     resolve agent route                                    │
│      │     record inbound session                                 │
│      │     store context_token (for later echo)                   │
│      │     get typing_ticket (cached)                             │
│      │     send typing indicator                                  │
│      │     dispatch to AI pipeline → reply                        │
│      ├─ on errcode -14:                                           │
│      │   pause all API calls for 60 min                           │
│      ├─ on API error:                                             │
│      │   retry 2s → 3 consecutive → backoff 30s                  │
│      └─ immediately re-poll                                       │
└──────────────────────────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ 5. GATEWAY STOP (per-account)                                     │
│    POST notifystop                                                │
│    abort long-poll                                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. Sent Message Shapes

### Text Message

```json
{
  "type": 1,
  "text_item": { "text": "Hello" }
}
```

### Image Message (after CDN upload)

```json
{
  "type": 2,
  "image_item": {
    "media": {
      "encrypt_query_param": "<download_encrypted_param>",
      "aes_key": "<base64(aeskey)>",
      "encrypt_type": 1
    },
    "mid_size": <ciphertext_size>
  }
}
```

### Video Message

```json
{
  "type": 5,
  "video_item": {
    "media": {
      "encrypt_query_param": "<download_encrypted_param>",
      "aes_key": "<base64(aeskey)>",
      "encrypt_type": 1
    },
    "video_size": <ciphertext_size>
  }
}
```

### File Message

```json
{
  "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "<download_encrypted_param>",
      "aes_key": "<base64(aeskey)>",
      "encrypt_type": 1
    },
    "file_name": "document.pdf",
    "len": "<plaintext_size_as_string>"
  }
}
```

---

## 8. AES-128-ECB Crypto

```javascript
// Node.js crypto
const cipher = createCipheriv("aes-128-ecb", key /* 16 bytes */, null);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

// Ciphertext size after PKCS7 padding:
const paddedSize = Math.ceil((plaintextSize + 1) / 16) * 16;
```

Key generation: `crypto.randomBytes(16)` — 16 bytes of randomness.

---

## 9. Session & Context

### Context Token

- Opaque string from `WeixinMessage.context_token` in inbound messages.
- Must be echoed verbatim in every outbound `sendmessage` to the same user.
- Stored per (accountId, userId) pair.

### Sync Buffer (`get_updates_buf`)

- Opaque base64 string from `GetUpdatesResp.get_updates_buf`.
- Acts as a cursor: tells server the last message batch processed.
- Persisted to disk at `~/.openclaw/openclaw-weixin/accounts/<id>.sync.json`.
- Restored on gateway restart.

### Session Expiry

- Server returns `errcode: -14` when session expires.
- Client pauses ALL API calls (inbound + outbound) for 60 minutes.
- During pause, `assertSessionActive()` throws for any API request.

---

## 10. Pairing / Authorization

- After QR login, the scanning user's `ilink_user_id` is auto-added to the allowlist.
- Allowlist stored at: `~/.openclaw/credentials/openclaw-weixin-<accountId>-allowFrom.json`
- Content: `{ "version": 1, "allowFrom": ["<userId>"] }`
- Only senders in the allowlist can trigger bot responses.
- DMs from non-allowed senders are silently dropped.

---

## 11. File Storage Layout

```
~/.openclaw/
  openclaw.json                                 # main config
  openclaw-weixin/
    accounts.json                                # index: ["norm-id-1", "norm-id-2", ...]
    accounts/
      <normalizedId>.json                        # { token, savedAt, baseUrl, userId }
      <normalizedId>.sync.json                   # { get_updates_buf: "<base64>" }
      <normalizedId>.context-tokens.json          # { "<userId>": "<context_token>", ... }
  credentials/
    openclaw-weixin-<normalizedId>-allowFrom.json # { version: 1, allowFrom: [...] }
```

Account normalization: `b0f5860fdecb@im.bot` → `b0f5860fdecb-im-bot` (filesystem-safe).
