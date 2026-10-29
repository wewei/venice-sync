# Venice.ai 存储模型

本文面向 Venice Sync 的后续开发与故障排查，描述**已观察到的网页端模型**，
不是 Venice 官方承诺稳定的接口或完整数据库规范。

- 观察与验证日期：**2026-10-27**。
- 范围：`https://venice.ai` 当前浏览器 profile、当前账户可访问的本地数据。
- 依据：网页原生代码、真实 Chrome 中的结构/字段检查，以及通过 Tampermonkey
  安装执行的导入、导出、原生界面显示和往返校验。
- 示例只使用占位符；本文不包含真实用户 ID、会话正文、角色指令、图片或密钥。
- “已观察”不等于所有账户、功能开关、历史版本和移动客户端都相同。
  版本或结构不匹配时应明确停止，不能靠猜测继续写入。

使用说明和命令见 [README](../README.md)。

## 1. 先区分业务实体

| 业务内容 | 主数据 | 不应混为一谈的内容 |
| --- | --- | --- |
| Classic 会话 | 会话元信息、文本消息、消息索引 | Mind/Agentic 的结构化响应 |
| Agentic 会话 | 无 Mind 绑定的 `chat` 线程及结构化消息 | Mind 定义、Studio 会话 |
| Mind 会话 | 绑定本地或远端 Mind 的 `chat` 线程及结构化消息 | Mind 定义及编辑助手 |
| Mind 定义 | 指令、模型、推理设置、工具/子 Agent、资源引用 | 普通 Mind 聊天记录 |
| Mind Builder Assistant | 编辑某个 Mind 的 `maker` 线程 | 使用该 Mind 聊天的 `chat` 线程 |
| Mind Preview | 编辑器的 `preview` 线程 | Builder 助手及普通聊天 |
| Character 定义 | 名称、描述、指令、开场白、设置、上下文文本、头像 | 角色聊天、记忆/洞察、公开角色目录 |
| Library / Studio Assets | 多个时期的生成记录、项目及媒体引用 | “所有 OPFS 文件”或“所有数据库” |

一个 Mind 可以同时拥有：

```text
Mind definition
├── avatar / cover / reference assets
├── Builder Assistant thread (maker)
├── Preview thread (preview)
└── ordinary user conversations (chat, zero or more)
```

完整 Mind 包保存前三类及定义本身；普通聊天通过 Conversations 单独迁移。
Character JSON 也只保存定义及其原生可携带内容，不隐式包含角色聊天。

## 2. 存储层与账户边界

### 2.1 各层职责

| 层 | 当前观察到的作用 |
| --- | --- |
| `localStorage` | 界面偏好、一些原生设置、Classic 加密密钥等 |
| `sessionStorage` | 标签页/会话状态，以及原生加密密钥的会话副本等 |
| IndexedDB + Dexie | Classic、当前 Character 定义及部分较早的 Studio 数据 |
| IndexedDB + RxDB | Mind 定义、Mind/Agentic/编辑器线程、结构化响应、附件/媒体元信息等 |
| OPFS | 头像、封面、参考附件、输入附件、生成/物化媒体等实际文件 |
| Venice 第一方服务 | 账户元信息、远端已发布 Mind/Character 等；不等于本地完整备份 |

这些数据按 **origin + 浏览器 profile** 隔离。切到另一个 Chrome profile，
即使登录的是同一账户，也不能假设其本地历史和 OPFS 文件已经一致。
本地 preview 的 origin 不是 `venice.ai`，因此不能用它验证真实业务数据读取。

### 2.2 两套用户 ID

这是目前最容易导致“库里有数据，列表却为空”的问题。

| 数据路径 | 本项目验证的归属 ID | 字段 |
| --- | --- | --- |
| Classic 会话 | Clerk `user.id` | `ownerId` |
| 当前原生 Character 定义 | Clerk `user.id` | `ownerId` |
| Mind 定义 | Venice 内部用户 ID | `ownerId` |
| Mind/Agentic/编辑器线程 | Venice 内部用户 ID | `ownerId` |
| RxDB 结构化消息 | Venice 内部用户 ID | `owner_id` |
| RxDB Mind 附件和媒体 | Venice 内部用户 ID | `ownerId` |

Venice 内部 ID 来自已认证的第一方账户资料，不应通过“任选一条本地记录的
owner”来猜测。当前实现通过原生 Clerk session getter 获取临时凭据，
只请求 `https://outerface.venice.ai/api/user/session`，
从响应的账户资料读取 `userId`；不是拿 Clerk ID 直接当作该 ID。

凭据只在内存中用于这次第一方身份请求，不写入归档、日志或项目文件。
该请求不上传聊天正文。

初始化也不能只检查 `Clerk.loaded`：已观察到它先为真，而用户或 session
对象稍后才就绪。应等待实际所需的 ID/getter，并在超时后明确报错。

实现入口：
[Classic 身份](../src/venice-classic.ts)、
[Venice 内部身份与 RxDB 访问](../src/native-rxdb.ts)。

## 3. 两套数据库，以及三种“版本”

### 3.1 当前适配器检查的版本

| 位置 | 版本含义 | 当前接受值 |
| --- | --- | --- |
| `venice-db-encrypted` | 浏览器 IndexedDB 数据库版本 | `310` |
| 原生 Dexie repository | Dexie `verno` | `31` |
| RxDB `minds` | 逻辑 collection schema version | `25` |
| RxDB `mindConversations` | 逻辑 collection schema version | `4` 或 `5` |
| RxDB `mindMessages` | 逻辑 collection schema version | `25` |
| RxDB `mindAttachments` | 逻辑 collection schema version | `0` |
| RxDB `mindMedia` | 逻辑 collection schema version | `6` |

不要把 IndexedDB 版本、Dexie 版本和 RxDB collection 版本相互比较。
例如，Dexie `31` 与其 IndexedDB `310` 是同一原生 repository 的不同表示；
RxDB 中的 `25` 不是另一个整个数据库版本。

`venice-rx-db-encrypted` 自身也有浏览器级数据库版本，但它会随物理 store
演进；当前适配器主要校验**活动逻辑 collection**，不把某次物理数据库版本
硬当成所有内容的业务 schema。

会话 schema v5 相对已观察的 v4 增加了 `studioProjectId`、
`studio` 类型及相关索引。普通聊天仍按 `type = chat` 处理；
不能把新出现的 Studio 关联当成无关字段静默带到另一个账户。

### 3.2 同名不等于同一个业务仓库

已观察到 RxDB 中也存在 `characters`、`conversations` 等名称及历史版本 store。
**当前网页实际创建 Character 的已验证路径仍是 Dexie `characters` 表**。
不能仅因 RxDB 有同名集合，就把 Character 写入那里并宣称已导入。

`folders` 等名字也可能同时存在于不同数据层，不能跨库只按名称拼接。

## 4. Classic：Dexie 会话与消息

数据库：`venice-db-encrypted`。

| Store | 主要字段/关系 |
| --- | --- |
| `conversations` | `id`、`ownerId`、`name`、`modelId`、文件夹及创建/更新时间 |
| `messages` | `id`、`conversationId`、`role`、`content`、`modelType`、时间及原生消息设置 |
| `messageIds` | 消息 ID、会话 ID、时间、`role`、`parentMessageId` 等索引投影 |
| `_encryptionSettings` | 加密策略及原生密钥一致性检查数据 |
| `messageImages` | 较早媒体路径的一部分；当前 Classic 文本迁移不处理它 |

核心关系：

```text
conversations.id
  ├── messages.conversationId
  └── messageIds.conversationId
```

`messageIds` 不是完整消息正文，也不是可以忽略的重复表。导入完整文本会话时，
必须同时建立它，否则原生消息读取/排序链路可能看不到刚写入的消息。

`parentMessageId` 不应一概当作“时间上的前一条消息”。当前 Classic v1
对非空 parent 明确拒绝，避免把编辑/分支关系错误地展平成普通线性历史。
`conversations.characterId` 等关联也不是普通无绑定文本历史。

### 4.1 加密与序列化

- 已观察的原生策略对 `conversations`、`messages` 使用
  `NON_INDEXED_FIELDS`；索引/主键字段保留在明文行上。
- `__encryptedData` 是 `Uint8Array`，布局为：
  **24-byte nonce + NaCl secretbox ciphertext**。
- 当前编码路径加密的是 Typeson 序列化后的完整行，不能仅按策略名称猜测
  密文里只有部分字段；读取时会合并明文索引列与解密对象。
- Typeson 用于保留 `undefined` 等原生类型语义。普通文本记录也可能带
  `$types` 注解，不能仅用 `JSON.parse` 就认为得到了原始对象。
- 原生 `encryptionKey` 在 local/session storage 中可被保存为 32 个字节的
  逗号分隔表示。备份代码不得导出、重建、重置或打印该密钥。
- 写入前需核对现有 `_encryptionSettings` 策略和密钥一致性。
  本项目只支持已经验证的策略，不启动迁移或密钥恢复。

数据库名含 `encrypted` **不表示其中每张表都按同一方式加密**：
Character 定义不应直接套用 Classic 密文编码器。

### 4.2 当前导入行为

新建会话/消息 ID、绑定当前账户、移除旧文件夹/临时会话状态；
在**一个 IndexedDB 事务**里 `add` 会话、消息、索引。
发生碰撞或请求错误时整个事务失败，不覆盖旧记录。

原生 Classic 列表使用独立应用缓存，直接落库不等于刷新列表；
当前成功导入后重载同一 URL。失败或取消不重载，确认前提示保存草稿。

实现：
[格式](../src/conversation-format.ts)、
[读写适配器](../src/venice-classic.ts)、
[现有数据库访问](../src/indexeddb.ts)。

## 5. RxDB：Agentic、Mind 与编辑器历史

数据库：`venice-rx-db-encrypted`。

### 5.1 逻辑模型

| Collection | 核心字段/关系 |
| --- | --- |
| `minds` | `id`、`ownerId`、名称/描述、指令、模型/推理配置、工具及资源引用 |
| `mindConversations` | `id`、`ownerId`、`name`、`type`、可选 `mindId`/`remoteMindId` |
| `mindMessages` | `id`、`owner_id`、`mind_conversation_id`、`role`、`status`、`turn_id`、`output_items` |
| `mindAttachments` | `id`、`ownerId`、`mindConversationId`、可选 `mindMessageId`、文件名/MIME/大小、可选提取文本 |
| `mindMedia` | `id`、`ownerId`、`mindConversationId`、可选 `mindMessageId`、带媒体类型的 `data` |

业务关系：

```text
minds.id ──────────────── mindConversations.mindId       (local)
remote published slug ── mindConversations.remoteMindId (remote)

mindConversations.id
  ├── mindMessages.mind_conversation_id
  ├── mindAttachments.mindConversationId
  └── mindMedia.mindConversationId

mindMessages.id
  ├── mindAttachments.mindMessageId (optional)
  └── mindMedia.mindMessageId       (optional)
```

### 5.2 会话类型的业务语义

| `type` / 绑定 | 语义 | 编辑器固定 ID |
| --- | --- | --- |
| `chat`，无 Mind 绑定 | Agentic 聊天 | 无 |
| `chat` + `mindId` | 本地 Mind 聊天 | 无 |
| `chat` + `remoteMindId` | 远端已发布 Mind 聊天 | 无 |
| `maker` + `mindId` | Mind Builder Assistant | `mind-maker-conv:{mindId}` |
| `preview` + `mindId` | Mind 编辑器预览聊天 | `mind-preview-conv:{mindId}` |
| `studio` / `studioProjectId` | Studio 关联会话 | 本项目尚不迁移 |

Agentic 不是另一张 `agenticMessages` 表，也不是“缺少字段的坏 Mind 会话”。
相反，格式校验必须确保 Agentic 没有 Mind 绑定、Mind 聊天有且只有一种绑定。

导入 Mind 定义后，如果只是随机创建一个 `maker` 会话 ID，即使记录落库，
编辑器也可能找不到历史。因此要重建上述固定 ID，并同步修改消息和文件关联。

### 5.3 消息不是一段 `content` 字符串

RxDB 消息中，`output_items` 可以包含：

- `message`：文字、拒绝及可能的多模态内容；
- `reasoning`：推理文本及相关元信息；
- 搜索、工具调用/返回、子 Agent 容器、审批、问卷等原生结构；
- 输入/输出图片、文件、视频等媒体引用。

同一响应中的条目/内容块还可能有：

- `id`、`response_id`、`item_id`；
- `output_index`、`content_index`；
- `turn_id`、`call_id`；
- `container_id`、`container_path`、媒体 ID 等。

这些关系需要一致地迁移。只替换顶层消息 ID 会造成内容或工具结果失联；
把整个数组转换成拼接字符串则会丢掉业务语义。
时间字段使用毫秒，但 RxDB 消息使用
`created_at_unix_timestamp` / `updated_at_unix_timestamp`，
与会话和定义的 camelCase 字段不同。

### 5.4 物理 store 不是可直接复制的业务 JSON

物理 IndexedDB 中可见类似：

```text
minds-25-documents
mindConversations-5-documents
mindMessages-25-documents
<collection>-<version>-wal
_rxdb_internal-...
rx-migration-state-...
```

已观察的存储行包含 `i`、`d`、`i0` 等物理字段；`d` 中可以包含业务文档和
`_rev`、`_meta`、`_deleted`、`_attachments`。还可能保留旧 schema 的 store。

因此：

1. IndexedDB `count()` 统计的是物理行，不等于当前账户的有效业务文档数。
2. 复制 `d` 而不处理索引/WAL/版本/变更通知，不能视为可靠导入。
3. 不在新归档里携带 RxDB 内部字段或照抄其物理索引。
4. 应使用现有原生实例的逻辑 API，让它维护索引、修订、删除标记和通知。
5. 已观察到部分 Mind 文档的业务字段可直接读取；仅凭数据库名或全局
   加密 wrapper 不能推出每个 collection、每个字段的加密状态。

当前通过 `OPEN_COLLECTIONS` 找到同一活动数据库的目标集合，
调用 `insert` / `bulkInsert` 等原生 API；不创建第二个数据库实例，
不复制 premium storage 实现，也不调用 React hooks 或修改 React 私有状态。

这条桥接使用的是**运行时可访问的模块导出**，并不是 Venice 官方稳定插件
API。bundle 模块 ID 仍可能随部署变化，必须保留类型、版本和实例唯一性检查。

实现：
[原生模块桥接](../src/native-runtime.ts)、
[活动集合与账户验证](../src/native-rxdb.ts)、
[会话校验和 ID 重建](../src/mind-conversation-format.ts)、
[逻辑会话读写](../src/venice-mind-history.ts)。

## 6. Mind 定义、发布状态与 OPFS

Mind 的主要定义字段包括：

- `name`、`description`、`longDescription`、`category`、`openingInstruction`；
- `systemPrompt.instructions`；
- `modelId`、`reasoningMode`、`hideReasoning`；
- `tools`：普通工具和含自身指令/工具的 `sub_agent`；
- `assets`、`avatarImage`、`coverImage`；
- 本地/发布关联与派生元信息，如 `remoteId`、`remoteDraftDirty`、
  `privacyLevel`、`usesCredits`。

定义里的图片/附件通常只是引用，不是实际文件字节。

### 6.1 已验证的 OPFS 路径

以下是**浏览器 OPFS 的逻辑路径**，不是 Windows 文件系统路径：

```text
minds/{mindId}/
├── avatar_images/{avatarId}.{extension}
├── cover_images/{coverId}.{extension}
└── assets/{assetId}.{extension}

media/mind-maker-conv:{mindId}/
├── {mediaId}.{extension}
└── attachments/{attachmentId}.{extension}

media/mind-preview-conv:{mindId}/
├── {mediaId}.{extension}
└── attachments/{attachmentId}.{extension}
```

普通 RxDB 会话的媒体也以原生会话 ID 为关联。只迁移图片的 `media_id`
而不带实际文件，原生消息结构虽存在，图像/文件仍无法恢复。

Venice 可能在原文件旁生成 `_thumb` 等派生缓存。完整包只带被定义/元信息
引用的原始资源，不把缩略图或孤立旧文件当作业务内容导出。
自定义 OPFS 读取使用 `create: false`；引用文件不存在时拒绝不完整归档。

### 6.2 Builder 历史不能重放

Builder 的工具可以直接修改 Mind 定义。“恢复工具历史”与“执行工具”是
完全不同的操作。当前完整包要求消息已结束，工具调用已有配对结果，
拒绝进行中调用、待审批动作和可恢复 continuation。

导入只写历史数据，不调用推理、工具执行或发布 API。已在真实原生编辑器中
验证恢复后的 Assistant / Preview 可显示且没有推理/发布请求；
这不意味着所有未来新增条目类型都无需验证即可接受。

### 6.3 新副本与远端内容

Mind 包导入会移除发布链接、远端媒体绑定和派生的隐私/计费元信息，
建立新的本地未发布副本。它不会覆盖或重新发布原 Mind。

本地聊天头像读取该 `mindId` 的本地原图。远端聊天头像使用原生第一方路径：

```text
https://outerface.venice.ai/api/v2/agents/{encodedRemoteMindId}/avatar
```

不能把同一 `remoteId` 对应的本地草稿头像替代为已发布版本的实时头像。
远端定义是否仍可访问，由 Venice 当前权限和发布状态决定。

实现：
[完整包格式](../src/mind-package-format.ts)、
[OPFS 边界](../src/mind-package-storage.ts)、
[Mind 包读写](../src/venice-mind-package.ts)、
[头像关联](../src/mind-avatars.ts)。

## 7. Character 定义与头像

### 7.1 当前原生定义

已验证的网页创建/导入路径使用 Dexie `characters` 表，主键为 `id`，
归属为 Clerk `ownerId`。其字段包含：

- `name`、`description`、`instructions`、`intro`；
- `textSettings.model`、`textSettings.advancedSettings`；
- 标签、语音、自定义系统提示词、推理/显示设置等；
- `context`：`id`、`fileName`、提取的 `text`、`tokens` 等；
- `photo` 或原生 `photoMedia`；
- `isPublic`、`isApiVisible`、`publicId`、`sourceId` 等状态/来源字段。

原生 JSON 可使用 `{ character, exportedAt, schemaVersion: "1" }`
包裹形式，当前本地校验也接受原生裸定义对象。
Character JSON 中的头像是嵌入图片数据，而不是 OPFS 引用。

`context` 的提取文本不等于上传前的完整 PDF/Word 等文件二进制。
当前定义备份不会伪造不存在的原始文件，也不会隐式带上聊天、记忆或洞察。

### 7.2 原生头像引用

已观察的引用布局：

```text
photoMedia:
  opfs-media:character-photos-{clerkOwnerId}|{characterId}__{nativeMediaId}

OPFS:
  media/character-photos-{clerkOwnerId}/
    {characterId}__{nativeMediaId}.{extension}
```

这与 `minds/{mindId}/avatar_images` 不是同一种路径。
导出调用原生 hydration helper，把头像转成 JSON 中的 `photo`。
导入调用原生存图 helper，再用 Dexie `add` 插入角色。
若原生 helper 返回缺失头像的结果，本项目会明确报错，而不是报告不完整成功。

失败清理仅允许本次新 UUID 的头像文件前缀，不删除账户共享头像目录。
导入清除旧账户、发布和来源绑定，将 `isPublic` / `isApiVisible` 置为 false，
重建为新的私有本地角色。

与 Classic 类似，成功导入后当前页面重载以更新原生缓存；
文件系统写入和数据库插入之间仍没有跨系统原子事务。

实现：
[Character 格式](../src/character-format.ts)、
[原生 repository/parser/photo 适配](../src/venice-characters.ts)。

## 8. Library / Studio：实际生成媒体聚合

当前原生路由是 `/studio/library`，不是单独一个 Library 表。
观察到的网页聚合路径由模块 `390220` 读取：

| 来源 | 归属及筛选 | 原文件位置 |
| --- | --- | --- |
| 旧版聊天 | Clerk 所属的非临时 `conversations`，再以 conversationId 关联 assistant 媒体消息；排除 placeholder | `media/{conversationId}/{id}.{ext}` |
| Studio 图像 | Dexie `studioImageTurnMedia`，Clerk ownerId，排除 `mediaRole=input` | `media/{sessionId}/{id}.{ext}` |
| Studio 音频 | Dexie `studioAudioTurnMedia`，Clerk ownerId | `media/{sessionId}/{id}.{ext}` |
| Mind 生成媒体 | RxDB `mindMedia` v6，Venice 内部 ownerId，generatedImage/generatedVideo | `media/{mindConversationId}/{id}.{ext}` |
| Discover 生成媒体 | RxDB `discoverGenerations` v9，内部 ownerId，completed 且为生成图片/视频 | `discover/generations/{id}.{ext}` |

扩展名由原生 `resolveMediaLocationParams` 计算，不能简单对 MIME 截取。
Dexie `messages` 没有 ownerId 索引，应从所属会话关联查询。
旧图像还可能存在 `messageImages.contentBinary` 内嵌副本。
缺失 MIME 时遵循原生图像 WebP、视频 MP4、音乐 MPEG 的回退类型；
明确不支持的 MIME 单独报错，不能让一项隐藏整个有效列表。
原生网页还会按用户设置筛选内容；存储资产列表不保证与其显示数量相等。

Studio 图像记录包含 sessionId、turnId、模型、prompt/imageSettings、
mediaRole、增强提示词等来源信息。不能由这些记录推导出完整项目迁移。
RxDB `studioProjects` / `studioOutputs` 属于另一代 Studio 模型，
不在本次观察到的网页 Library 聚合路径内。
`userMedia` v1 则主要是上传文件，路径 `user-media/{id}.{ext}`；
其原生 size 字段观察到使用 KB，不可假定为字节，也不能仅写入该表
就宣称资产已进入网页 Library。

### 8.1 原始资产 ZIP 与独立副本

本项目的 v1 ZIP 仅含 `manifest.json` 和 `asset.bin`：一个不改字节的原文件，
SHA-256、字节数、MIME 和清除账户归属字段后的来源元信息。
不包含源会话、Studio 项目、生成输入、外部封面和缩略图缓存。
来源提示词/设置只作为 provenance 保留，不恢复成可执行生成配置。

导入先解码验证，再为原文件和可选的 500px JPEG 缩略图生成新 UUID 路径：

```text
media/{newConversationId}/{newAssetId}.{nativeExtension}
thumbnails/{newConversationId}_{newAssetId}_thumb500.jpg
```

随后通过原生 Dexie 的一个事务 `add` 新永久媒体容器会话、
assistant 媒体消息及 `messageIds` 投影。图片/视频/音频分别采用
image/video/music 类型，并明确标识 `Imported Library asset`，
不伪造一次生成。`veniceSyncLibrary` 保存原来源元信息，供再次导出。
这个容器也可能出现在 Conversations；确认页会告知，并在成功后重载同一页面。
文件写入失败或数据库事务失败，仅清理本次 UUID 命名空间。

### 8.2 只读与原生缩略图的区别

原生 Library 缩略图 hook 在找不到部分 Studio 原文件时可能删除媒体记录。
因此本项目列表/预览直接以 existing-only OPFS handle 读取，
**不调用该 hook，也不为“修复”预览删记录或创建目录**。
原文件缺失或格式不支持会明确显示；不能导出空壳或下载外链冒充本地原件。

实现：[ZIP 格式](../src/library-format.ts)、
[原生列表与导入事务](../src/venice-library.ts)、
[受限 OPFS 操作](../src/library-files.ts)。

### 8.3 经典 Studio 可编辑 Session

Library 的单资产传输保持不变；另一个入口 **Library Assets > Studio Sessions**
归档整个经典图片/音频会话。实现见 [格式](../src/studio-session-format.ts)、
[原生适配器](../src/venice-studio.ts)。原始调查见
[Studio Sessions 调查报告](studio-sessions-investigation.md)。

图片表：`studioImageSessions` / `studioImageTurns` / `studioImageTurnMedia`；
音频表：`studioAudioSessions` / `studioAudioTurns` / `studioAudioTurnMedia`。
三层关系是 Session → Turn → Media，均采用当前 Clerk `ownerId`。
运行中的原生 Dexie 返回解密后的逻辑行，导入时由同一个原生仓库重新加密；
不是把 `__encryptedData` 或源浏览器密钥搬到目标。

图片会话 `type=generate|edit`，`selectedImageId` 指向媒体行；
编辑 Turn 的 `input={id,fileName,mimeType}` 也必须对应同会话媒体，不能遗漏输入原件。
输出 `mediaRole=output`，输入 `mediaRole=input`。图片文件在
`media/{sessionId}/{mediaId}.{ext}`，可重建的原生 Studio 缩略图为
`thumbnails/{sessionId}_{mediaId}_thumb.jpg`，不等同于单资产导入的 `_thumb500.jpg`。

音频会话 `type=audio-generate`，`selectedAudioId` 指向音频媒体。
Turn 保留 `prompt/effectivePrompt/lyricsPrompt/settings`，
媒体保留模型、`audioSettings`、时长以及已识别的句子/单词字幕结构。
当前音频源表为空，因此其字段证据来自当前公开下发的原生 producer；
使用合成 WAV 会话验证了原生写入、再导出和原生编辑器读取，没有付费生成。
`sourceAudio` 实际指向账户级 `media/audio-studio-source-{ownerId}/attachments/…`，
克隆声音也可能绑定账户，因此本版明确拒绝这些引用，不凭空重建。
音频本地封面通常位于 `audio-thumbnails/{sessionId}_{mediaId}.webp`；
本版只接受原生默认封面或无封面，遇到自定义/远程封面整份拒绝，避免丢失资源。

ZIP 的 `manifest.json` 内联会话/turn/media 数据及文件清单，原件保留在
`media/…` 路径；不迁移账户偏好、active-session localStorage 或生成任务。
导入为三个层级生成新 UUID，只重写已验证的引用字段和文件路径，不能对用户
prompt 内容做字符串替换。先解码/校验、再写新 OPFS 命名空间，最后在原生 Dexie
单事务中 `add` 对应三张表；失败清理仅限本次新目录/缓存。确认页提示成功后重载。
未知字段、跨会话引用、无产出的未完成 turn、缺失原件和不支持的资源都会显式失败。
导出前后比较记录快照，不能保证与并发编辑/生成互斥；应先结束操作再导出。

新编排器 `studioProjects/studioOutputs`、视频 Session 仍未实现，不能把它们
当作普通图片/音频 Session 迁移。原生 UI 的 active-session key 是
`studio_active_session_{generate|edit|audio-generate}_{ownerId}`，
对应 `/studio/image`、`/studio/edit`、`/studio/audio`；正常导入不修改这些偏好。

## 9. 本项目的归档与一致性边界

| 内容 | 当前格式与上限 | 当前范围 |
| --- | --- | --- |
| Classic | `venice-sync-classic` v1 JSON；8 MiB | 无角色绑定的普通文本；不迁移分支/附件 |
| Mind 聊天 | `venice-sync-mind-conversation` v1 JSON；8 MiB | 已结束的文本、拒绝和推理；选择现有目标 Mind |
| Agentic 聊天 | `venice-sync-agentic-conversation` v1 JSON；8 MiB | 已结束的文本、拒绝和推理；不建立 Mind 绑定 |
| Mind 定义 | `venice-sync-mind` v1 ZIP | 定义、原始资源、所有已保存的 Assistant/Preview 历史 |
| Character | Venice 原生 schemaVersion `"1"` JSON；8 MiB | 定义、内嵌头像、设置与已保存上下文文本 |
| Library 资产 | `venice-sync-library-asset` v1 ZIP；原文件 100 MiB、元信息 8 MiB、ZIP 128 MiB | 单个原始图片/视频/音频及来源元信息；独立副本，不迁移源项目 |
| 经典 Studio Session | `venice-sync-studio-session` v1 ZIP；总量 128 MiB、原文件 100 MiB、元信息 8 MiB、2048 原件 | 可编辑图片/普通音频 Session、turn、媒体、图片输入原件；不包含 beta/video、音频 sourceAudio/克隆声音/自定义封面 |

Mind ZIP 限制：压缩/展开总量 128 MiB、单文件 25 MiB、元信息 8 MiB、
最多 2048 个资源文件，逐文件校验大小和 SHA-256。路径和归属也必须校验；
SHA-256 只检查内容一致性，**不证明归档来自可信作者**。

普通 Mind/Agentic JSON 目前不支持工具执行或媒体历史，会整份拒绝而非静默
删掉不支持的条目。完整 Mind 包对编辑器历史支持更丰富的结构；
不能用“放宽普通会话校验”冒充两者等价。

| 写入路径 | 一致性模型 | 原生 UI 刷新 |
| --- | --- | --- |
| Classic | 单个 IndexedDB 事务内 add 多张表 | 成功后重载同一页面 |
| Mind/Agentic 聊天 | 先写新消息，后创建线程；失败定向清理 | 原生 RxDB 响应式更新 |
| 完整 Mind | 先文件/辅助数据/编辑器历史，最后定义；失败定向清理 | 原生 RxDB 更新 |
| Character | 先新头像，后原生 Dexie add；失败定向清理 | 成功后重载同一页面 |
| Library 资产 | 先原文件/缩略图，后单个 Dexie 多表 add 事务；失败定向清理 | 成功后重载同一页面 |
| 经典 Studio Session | 先原文件/图片缓存，后一个原生 Dexie 三表 add 事务；失败定向清理 | 成功后重载同一页面 |

所有导入都创建新副本，重新绑定当前账户并重建必要引用，不覆盖原记录。
但 RxDB 多 collection 与 OPFS 不存在一个通用跨系统事务；
进程退出、强制关闭标签页或配额错误之后不能宣称绝对原子恢复。
不完整回滚必须显式报告，不应自动重试并产生更多副本。

### 9.1 跨类别导出篮与 CAS 中立运输包

批量操作不改写上述业务格式。各内容页把 `{kind,id,title}` 加入同一内存篮子，
按 kind/id 去重；下载时重新通过既有导出器读取原生数据，逐项校验归属和支持范围。
一个项目失败则停止，不交付静默缺项的“成功”归档；关闭面板清空篮子并取消待下载结果。
这是顺序读取的内容集合，**不是数据库/OPFS 跨源一致性事务，也不是账户时间点快照**。

`venice-sync-batch` v1 ZIP 仅包含 `manifest.json` 与 `objects/{sha256}`。
清单为每个项目记录原格式、原 ID、显示名、输出文件名和逻辑路径→对象 hash/字节数映射。
Mind/Studio/Library 原 ZIP 被展开为原 manifest 与资源对象，不在批量 ZIP 中嵌套 ZIP。
完全相同的字节跨项目共享一个对象；JSON 对象键稳定排序，数组和正文保持原语义。
原导出的 exportedAt 等字段保留，Character 内嵌头像仍属于 Character JSON；
本版不宣称实现跨设备稳定业务 ID、历史节点归一化或完整资源级拆分。

包内 raw SHA-256 是文件字节标识，**不等于 UniCAS 规范 node digest**。
运输层与逻辑对象准备分离，未来可为清单和资源适配 UniCAS node/ref，
但现在不执行网络上传、capability 签发、retain/release、目录提交或分享授权。

打开包先验证对象、路径和原单项格式，再允许“取出”单项 JSON/重建 ZIP；
后续仍使用对应单项导入预览/确认，打开或取出本身无持久化写入。
Mind 聊天不会自动携带定义，也不会因为同包存在定义而自动绑定新 Mind。
当前上限为 200 项、4096 逻辑文件、8 MiB 元信息、128 MiB 逻辑原件/
实际展开/最终 ZIP；逻辑上限保守地重复计算共享文件。所有归档仍为明文。

实现：[批量格式](../src/batch-format.ts)、
[原生导出协调](../src/batch-export.ts)、[导出篮](../src/BatchBasket.tsx)。

## 10. 排查与后续适配

### 列表为空

依次检查 origin/profile、实际登录状态、正确的两套 owner ID、
活动 schema、逻辑删除和会话 `type`/绑定。不要先导入到另一张同名表。

### 数据导入了但原站看不到

区分数据库写入成功与原生缓存/响应式事件更新；
确认消息索引、固定编辑器 ID、归属和关联是否齐全。
不要通过添加成功外观的空默认值掩盖问题。

### 图片元信息在、文件不在

核对对应存储模型和 OPFS 路径、原图与缩略图、选中的本地/远端 Mind。
原生某些媒体读取 helper 会创建目录，不宜直接当成严格只读文件枚举器。

### Venice 更新

重新检查活动 schema、枚举值、原生 module 导出和图像序列化方式，
先做结构比较，再加受限兼容。曾观察到会话 v4 到 v5 的部署更新，
因此版本失配不是“可忽略的小错误”。

当前 bundle 中使用的模块号包括 RxDB core `947217`、Dexie repository
`342219`、Character photo helper `951225`、Character JSON parser `488857`。
这些数字只是适配器的当前 ABI 线索，不是官方接口名。

### 验证标准

- 用真实 Tampermonkey 安装并执行，不用 Playwright 注入脚本冒充。
- 以合成数据验证导出、导入、再次导出、原生界面显示和重载后显示。
- 用户指定原件只读，测试建立副本；检查原记录/资源指纹未变。
- 检查 ID 重建、文件校验和、原生列表刷新以及失败回滚。
- 导入历史不提交推理、不重放工具、不发布内容。
- 清理仅限本次生成的 ID/文件，并核对既有记录没有变化。

测试入口：
[单元与 UI 测试](../src/)、
[真实 Chrome/Tampermonkey E2E](../scripts/e2e-chrome.mjs)、
[纯合成样本](../scripts/fixtures/)。

运行报告和截图位于被 Git 忽略的 `test-results/`；
不能将其中可能出现的用户标题、头像或其他本地资料随代码提交。
