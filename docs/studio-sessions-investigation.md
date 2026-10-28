# Venice Studio 编辑 Sessions 调查报告

调查日期：2026-10-28。方法：在已登录 Venice（PRO 账号）的真实 Chrome（CDP +
Playwright）中实际操作 `/studio/image` 完成一次图片生成，随后直接读取
IndexedDB / OPFS 原始数据；结合已导出的 30 个 RxDB collection schema
（`studio-schemas.json`）与全库 inventory（`studio-inventory.json`）交叉验证。
本文记录最初调查结果；后续实现状态与补充验证见文末 §7。

## 1. 结论速览

1. **经典 Studio（当前线上默认 UI）的会话数据存于 Dexie 库
   `venice-db-encrypted`**（观察版本 v310），共 7 个 `studio*` store：
   `studioImageSessions` / `studioImageTurns` / `studioImageTurnMedia`、
   `studioAudioSessions` / `studioAudioTurns` / `studioAudioTurnMedia`、
   `studioVideoSessions`。
2. **生成产物二进制存于 OPFS**：`media/{sessionId}/{mediaId}.{ext}`，
   缩略图 `thumbnails/{sessionId}_{mediaId}_thumb.jpg`（注意：Studio 原生缩略图
   后缀是 `_thumb.jpg`，与本项目 Library 导入写的 `_thumb500.jpg` 不同）。
3. **存在另一代"新编排器"（beta）模型**：RxDB 库 `venice-rx-db-encrypted` 中的
   `studioProjects` / `studioOutputs`。本次账号实测中，经经典图片 tab 生成
   **不会**写入这两个 collection（生成后仍为 0 条），经典路径与新编排器路径
   是两套独立存储。
4. 会话核心内容都在 `__encryptedData` 加密块中（与 Classic/Mind 相同的加密
   机制），明文索引字段仅 id / ownerId / sessionId / turnId / 时间戳 / type。
5. `video-studio-recovery.activeGenerations` 记录进行中的生成任务（观察时 0 条），
   属于瞬态恢复数据，不是归档目标。

## 2. 实测证据：一次图片生成的完整落盘

操作：`/studio/image`，提示词 "a cute white lop-eared rabbit on green grass,
soft light"，模型 Z-Image Turbo，1:1。生成耗时约 17.4s。

### 2.1 Dexie `venice-db-encrypted`（3 个 store 各写入 1 条）

```text
studioImageSessions: {
  id: "56047b57-226a-4cc3-9014-e04491ecf380",     // sessionId
  ownerId: "user_2woG…hsS",                        // Clerk 用户 id
  type: "generate",
  createdAtUnixTimestamp: 1793197372216,
  updatedAtUnixTimestamp: 1793197385557,
  __encryptedData: <293 bytes>                     // 会话标题/设置等
}
studioImageTurns: {
  id: "30fe40e0-047e-4879-afe6-6a88c74dc761",     // turnId
  sessionId: "56047b57-…",
  ownerId: "user_2woG…hsS",
  createdAtUnixTimestamp: 1793197372361,
  __encryptedData: <288 bytes>                     // prompt/参数等
}
studioImageTurnMedia: {
  id: "b9abf7b5-5812-4042-8e31-f8fc19f96409",     // mediaId
  turnId: "30fe40e0-…",
  sessionId: "56047b57-…",
  ownerId: "user_2woG…hsS",
  createdAtUnixTimestamp: 1793197385420,
  __encryptedData: <1891 bytes>                    // 模型/尺寸/mediaRole/增强提示词等
}
```

层级关系：**Session 1—N Turn 1—N TurnMedia**，全部通过明文外键
（sessionId / turnId）关联，归属通过 Clerk ownerId。

### 2.2 OPFS（2 个文件）

```text
media/56047b57-…/b9abf7b5-….webp                    240,936 bytes（原图）
thumbnails/56047b57-…_b9abf7b5-…_thumb.jpg           43,326 bytes
```

路径模式与 `docs/venice-storage-model.md` §8 中"Studio 图像 →
`media/{sessionId}/{id}.{ext}`"的既有观察一致；缩略图命名规则本次新增确认。

### 2.3 设置存储（`settings` store，明文）

`venice-db-encrypted.settings` 按 ownerId 存一条用户设置，包含
`imageModel: "z-image-turbo"`、`imageSettings`（aspectRatio / cfgScale /
customSeed / format / height 等）、`videoSettings`、`inpaint*`、
`referenceAspectRatio` 等 Studio 相关默认参数。这些是**用户级偏好**，
不属于单个会话，导入导出会话时不应携带（或仅作 provenance 参考）。

## 3. 新编排器（beta）：RxDB `studioProjects` / `studioOutputs`

`/studio` 默认落在"新编排器（测试版）"，提供 视频草稿 / 关键帧 / 多参考 /
编辑视频 等模式。schema 已完整导出（30 个 collection 之一部分）：

### 3.1 `studioProjects`（RxDB store: `studioProjects-0-documents`）

```text
primaryKey: id；encrypted: []（依赖 RxDB 库级加密）
必填: id, name, ownerId, createdAtUnixTimestamp, updatedAtUnixTimestamp
可选: composer(object), folders(array), references(array), storage(string)
索引: [_deleted, ownerId, updatedAtUnixTimestamp, id]
```

`composer` 推测为编辑器工程状态（时间线/图层/关键帧），`storage` 推测为存储
模式标记。**本账号无实测数据（0 条），字段语义未验证。**

### 3.2 `studioOutputs`（RxDB store: `studioOutputs-1-documents`）

```text
primaryKey: id
必填: id, projectId, ownerId, kind, op, status, title, titleSource,
      inputs(array), favorite, visibility, createdAtUnixTimestamp,
      updatedAtUnixTimestamp
可选: media(object), job(object), draft(object), settings(object), seed,
      prompt, rewrittenPrompt, effectivePrompt, modelId, modelName,
      workflow, subtitles(object), folderId, creditsQuoted, error,
      failure(object), downloadedAtUnixTimestamp,
      isContentViolation, isAdultModelContentViolation
索引: [_deleted, projectId, createdAtUnixTimestamp, id],
      [_deleted, ownerId, status, createdAtUnixTimestamp, id]
```

`projectId` 外键指向 `studioProjects`；`kind`/`op` 区分产物类型与操作类型；
`job` 推测记录生成任务状态机。**同样无实测数据。**

### 3.3 两代模型的关系（实测）

在本次生成测试中，`venice-rx-db-encrypted` 的 `studioProjects-0-documents` /
`studioOutputs-1-documents` **保持 0 条**——经典图片 tab 的生成只写 Dexie。
与 `venice-storage-model.md` §8 "RxDB studioProjects/studioOutputs 属于另一代
Studio 模型，不在 Library 聚合路径内" 的结论互相印证。新编排器创建的工程
预期写入 RxDB 侧，但**需要实际在新编排器中创建工程才能验证**（本次未做：
视频生成成本高，且 beta 行为可能变化）。

## 4. 与现有代码的关系

- `src/venice-library.ts` 已读取 `studioImageTurnMedia` / `studioAudioTurnMedia`
  （排除 `mediaRole=input`）作为 Library 资产导出**产出文件**；不读
  sessions/turns，因此**不具备恢复可编辑会话的能力**——这正是本次要补的缺口。
- 加解密模式已有成熟先例：`src/venice-classic.ts` 的
  `__encryptedData` ↔ `encryptionKey()` 解密/再加密（characters 导入时重打包
  `__encryptedData`，见 `src/venice-characters.ts`）。Studio session 跨浏览器/
  账号导入必须走同样的 解密→改归属→再加密 流程。
- OPFS 受限读写已有 `src/library-files.ts`（existing-only 读、按 UUID 命名空间
  写、失败清理），可直接复用。

## 5. 建议的导入导出数据模型（供 Phase 2 讨论）

**导出单元 = Session**（与 Mind ZIP 的思路一致）：

```text
venice-sync-studio-session v1 (ZIP)
├── manifest.json        # 格式版本、导出时间、kind(image|audio|video)、
│                        # 来源 {sessionId, ownerId 已剥离}、文件清单+SHA-256
├── session.json         # session 行（解密后的明文，剥离账号字段）
├── turns/*.json         # 每 turn 解密明文
├── media/*.json         # 每 turnMedia 解密明文（含 mediaRole、模型、尺寸）
└── files/               # OPFS 原件：media/{mediaId}.{ext}（必需）
                         # 缩略图可不带（导入后原生会按需重建或留空）
```

**导入**：新 UUID 三件套（sessionId/turnId/mediaId）→ 写 OPFS
`media/{newSessionId}/…` → 明文改归属（当前 Clerk ownerId）→ 用目标浏览器
`encryptionKey()` 重加密 `__encryptedData` → 单事务写三个 Dexie store。
与 Library 导入相同的失败清理原则（只清本次 UUID 命名空间）。

**范围建议（分两步）**：
1. **Phase 2a**：经典 image/audio sessions（数据形状已实测确认，可立即做）。
2. **Phase 2b**：新编排器 projects/outputs（等真实数据出现后另行调查——
   需要在"新编排器"里实际建一个工程；schema 虽在手，`composer`/`storage`/
   `job` 语义未验证，贸然实现风险高）。

## 6. 局限与未验证项

- `studioVideoSessions` 无实测数据（视频生成成本高，未执行）；其 turn/媒体
  store 命名未在 inventory 中出现（只有 sessions 一个 store），视频会话的
  媒体可能挂在 `studioImageTurnMedia` 同构的其他 store 或直接走 RxDB，待验证。
- `__encryptedData` 内部字段结构未解密展开（报告仅确认加密块大小与外层明文
  字段）；实现导出时需要用页面上下文的 decryptionKey 实际解密验证字段。
- 新编排器（beta）全部未实测；`video-studio-recovery` 仅观察到空表。
- 原始数据文件（inventory/schemas/OPFS 清单）存于本次调查会话目录，
  仓库内保留本报告的文字结论；如需原始 JSON 可在同环境重跑
  `~/.copilot/session-state/9a6a4efc-*/files/studio-inspect.mjs`。

## 7. 后续实现与补充验证（2026-10-28）

已实现经典图片/普通音频 Session ZIP 传输，入口为
**Library Assets > Studio Sessions**，与原来的单资产 Library 视图分开。
具体用法、上限和明确拒绝的资源见 [README](../README.md#editable-studio-session-transfer)
及 [存储模型 §8.3](venice-storage-model.md#83-经典-studio-可编辑-session)。

补充观察：通过运行中的原生 Dexie 读取到了已解密图片 Session/Turn/Media，
确认 `selectedImageId`、编辑输入 `input={id,fileName,mimeType}`、
`mediaRole=input|output` 和同会话 OPFS 路径。图片输入原件与输出一起归档。
音频表仍为空；当前原生 producer 确认音频 `type=audio-generate`、
`selectedAudioId`、Turn 的 settings/effectivePrompt/lyricsPrompt，
以及媒体的 audioSettings/subtitle/durationSeconds。并非真实音频生成实测。

真实 Chrome + 已安装 Tampermonkey 验证了合成图片编辑会话与合成静音 WAV 会话的
预览/取消、导入、导出、再次导入、字节/SHA-256、一致引用、原生编辑器读取与定向清理。
原记录指纹不变，无推理或发布请求；没有以注入 bundle 冒充油猴运行。

第一版对音频 `sourceAudio`（账户级附件目录）、账户绑定克隆声音、自定义/远程封面、
未知字幕形状明确拒绝，不会静默丢弃。新编排器与视频 Session 继续等待专门调查。
