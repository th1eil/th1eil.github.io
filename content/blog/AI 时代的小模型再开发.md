+++
title = "【Vibe】小模型开发的一些总结 "
date = 2026-06-23
description = "近期的工作。"
taxonomies = { tags = ["llm"] }
template = "blog-page.html"
draft = false

+++

# AI 时代小模型项目开发经验之谈

> 项目类型：实时语音识别 + 对话服务（ASR/VAD/LLM/TTS 全链路）
> 技术栈：Python/FastAPI、Qwen3-ASR/TTS、Silero VAD、Docker Compose、WebSocket
> 开发周期：2026-06-08 ~ 2026-06-22（约 2 周），AI 开发

---

## 一、架构设计的核心经验

### 1.1 插件化 = 未来proof

**项目中最成功的决策**就是 `backend/plugins/` 的抽象基类 + 注册表 + 工厂函数模式：

```python
# 四个核心能力组件的抽象接口
BaseASRProvider   # 语音识别
BaseVADProvider   # 语音活动检测
BaseLLMProvider   # 大语言模型
BaseTTSProvider   # 语音合成

# 注册表：一行切换实现
_ASR_REGISTRY = {
    "qwen3": "...Qwen3ASRProvider",
    "http_asr": "...HttpASRProvider",
}
```

**为什么这个设计在 AI 项目中尤其重要：**

| 场景 | 没有插件化 | 有插件化 |
|------|-----------|---------|
| 模型从 Qwen3 换成 Whisper | 改几十处代码 | 注册一行，`.env` 改一行 |
| 本地部署 → Docker 微服务 | 重写架构 | `USE_REMOTE_PLUGINS=true` |
| ASR 后端从 from_pretrained 切到 vLLM | 改 pipeline | provider 内部封装 |
| 新增 LLM provider（如 Claude） | 改 LLM 客户端 | 实现基类 + 注册 |

**经验：AI 模型迭代速度极快，今天的最优模型明天就可能被替代。插件化不是"过度设计"，而是对不确定性的风险管理。** 它让"换模型"这个最高频操作的成本降到最低。

### 1.2 渐进式架构演进：单体 → 微服务，不要一步到位

项目的架构演进路径非常清晰：

```
阶段 1: 单体应用
  gateway 直接加载 ASR/VAD 模型，以本地对象调用
  → 适合开发调试，一台机器跑通全流程

阶段 2: 远程插件模式
  gateway 通过 HTTP/WS 调用独立的 ASR/VAD/TTS 容器
  → 适合生产部署，GPU 资源隔离，独立扩缩容
```

**关键设计：两个阶段共用同一套代码。** `server.py` 中只有这一行判断：

```python
if _USE_REMOTE:
    os.environ["ASR_PROVIDER"] = "http_asr"  # 切换到 HTTP 客户端
```

其余代码完全不变。`HttpASRProvider` 实现了和 `Qwen3ASRProvider` 完全相同的接口，Pipeline 层完全无感。

**经验：不要在项目初期就追求完美的微服务架构。先让单体跑通，再用插件化实现平滑过渡。** 在小模型项目中，模型加载和推理是核心瓶颈——先把这些搞稳定，再谈拆分。

### 1.3 Pipeline 编排器：解耦能力组合与具体实现

项目中 `ChatPipeline` 和 `ASRPipeline` 是纯编排层，不关心 ASR/VAD/LLM 的具体实现：

```python
class ChatPipeline:
    def __init__(self, vad, asr, llm, tts=None, ...):
        self.vad = vad    # 任何 BaseVADProvider
        self.asr = asr    # 任何 BaseASRProvider
        self.llm = llm    # 任何 BaseLLMProvider
        self.tts = tts    # 任何 BaseTTSProvider
```

**Pipeline 只做三件事：**
1. 协调 VAD→ASR→LLM→TTS 的调用顺序
2. 管理流式状态（streaming state 的创建/喂入/结束/清理）
3. 通过回调把事件传递出去

**经验：编排器 + 插件 = 可组合的能力矩阵。** 新增一个 "纯 ASR 不含 LLM" 的端点，只需写 267 行 `ASRPipeline`，复用已有的 VAD 和 ASR provider，不需要碰任何模型代码。

---

## 二、配置管理：`.env` 是 AI 项目的一等公民

### 2.1 配置项清单即项目接口文档

Pydantic Settings 的好处远超"类型校验"：

```python
class Settings(BaseSettings):
    ASR_PROVIDER: str = "qwen3"       # 不只是字符串，是架构决策
    ASR_MODEL: str = "Qwen/Qwen3-ASR-0.6B"   # 不只是路径，是模型版本
    ASR_DEVICE: str = "cpu"           # 不只是设备，是成本/延迟权衡
    ASR_USE_VLLM: bool = False        # 不只是开关，是流式能力开关
```

**经验：对于 AI 项目，`.env` 文件 = 生产环境的"控制面板"。** 换模型、切 GPU、调推理参数——都应该通过改 `.env` 完成，不应该改代码。Pydantic Settings 的 `env_file=".env"` + `case_sensitive=True` 提供了免费的类型校验和文档。

### 2.2 配置的时机问题：初始化顺序是 bug 之源

项目踩过的坑：

```python
# ❌ 错误：模块导入时就实例化 Settings
# config.py 底部
settings = Settings()  # 此时 USE_REMOTE_PLUGINS 还没处理

# ✅ 正确：延迟实例化，等调用方准备好后再读
def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings

# server.py 先修正环境变量，再调用 get_settings()
if _USE_REMOTE:
    os.environ["ASR_PROVIDER"] = "http_asr"  # 先修正
cfg = get_settings()  # 再读取
```

**经验：AI 项目的配置有"模式切换"层级（本机/远程、GPU/CPU、vLLM/from_pretrained）。** 这些不是简单的 key=value，而是会触发完全不同的模块导入路径。务必确保配置读取发生在所有环境变量修正之后。

---

## 三、AI 模型特有的工程挑战

### 3.1 流式 vs 非流式：两种完全不同的编程模型

项目经历了一个重要的认知升级：**"流式 ASR"远不只是"逐 chunk 调用 API"。**

| 维度 | 非流式（batch） | 流式（streaming） |
|------|----------------|-------------------|
| 状态管理 | 无状态 | 需要 `ASRStreamingState` 生命周期管理 |
| 错误处理 | try/except 包裹一次调用 | 每个 chunk 都可能失败，需要降级 |
| 资源释放 | 自动 | 必须显式 `finish()` 或 `abort()`，否则 GPU 泄漏 |
| 并发 | 线程池串行即可 | 需要非阻塞 recv + 超时处理 |
| 延迟模型 | 等待整句结束 | 边说边出字，VAD 切分策略决定体验 |

**项目实现的流式降级策略值得借鉴：**

```python
async def _on_speech_start(self, vad_infer_ms):
    if self.asr.supports_streaming:
        try:
            self._streaming_state = await loop.run_in_executor(
                self._asr_executor, self.asr.init_streaming_state
            )
        except Exception as e:
            logger.warning("流式 ASR 初始化失败，降级到整段识别: %s", e)
            self._streaming_state = None  # 自动降级！
```

**经验：流式能力永远应该有非流式兜底。** vLLM 后端、WebSocket 连接、GPU 显存——任何一环出问题，都应该自动回退到整段识别，而不是让整个服务不可用。

### 3.2 资源泄漏是 AI 服务的第一大敌人

项目中实际发生并被修复的泄漏场景：

| 泄漏类型 | 原因 | 修复 |
|---------|------|------|
| GPU 显存泄漏 | WS 异常断开时 vllm_state 未清理 | `finally` 块强制 `finish_streaming_transcribe` + 超时自动清理 |
| WebSocket 连接泄漏 | gateway abort 时只设 state=None | `abort_streaming()` 发送 cancel 帧 + close WS |
| TTS 磁盘泄漏 | 每次合成都写 WAV 到磁盘 | 改为 `TTSResult.audio_bytes` 内存返回，30min TTL 自动清理 |
| 线程池泄漏 | `asr_executor` 线程被阻塞 | finish 前先排空积压响应，非阻塞 recv(timeout=0.5) |

**经验：AI 模型推理是重量级资源操作。每个 `init` 必须有对应的 `cleanup`，每个资源申请必须有 TTL。** 不在 finally 块里写资源释放代码的 AI 服务，迟早会在生产环境 OOM。

### 3.3 Docker 构建：模型下载是 CI/CD 的最大瓶颈

项目踩过的 Docker 坑：

1. **大文件缓存策略**：`torch` wheel 很大，必须和 `torchaudio` 分开 `RUN` 层：
   ```dockerfile
   RUN pip install torch==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
   RUN pip install torchaudio==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
   # 而不是 RUN pip install torch torchaudio ... （改一个重下两个）
   ```

2. **healthcheck 要给模型加载留足时间**：Qwen3-TTS 首次启动可能下载/加载模型 5-10 分钟：
   ```yaml
   healthcheck:
     start_period: 900s  # 不是 30s！
   ```

3. **runtime 补装依赖**：构建缓存可能让你漏装间接依赖（如 `packaging`），在 runtime 最终层补装是保险做法。

4. **离线部署**：通过 `HF_ENDPOINT` 环境变量指向 HuggingFace 镜像或本地缓存，避免生产环境下载模型。

**经验：AI 项目的 Docker 镜像动辄 10-30GB。** 分层策略、缓存利用、模型挂载（volume 而非 COPY）直接决定 CI/CD 是 2 分钟还是 2 小时。

---

## 四、开发流程：AI 辅助开发的实战模式

### 4.1 文档驱动开发

项目的文档齐全程度远超普通项目：

```
README.md                        # 项目总览 + 快速启动
architecture.md                  # 架构深度解析（985行）
操作手册.md                       # 部署/更新/排障
asr语言服务API接口文档.md          # 接口规范
OpenAI语音服务接口文档.md          # API 兼容性文档
适配最低要求文档.md                # 多平台部署 checklist
接口测试报告-2026-06-17.md         # 4 份递增测试报告
开发文档.md                       # 14 条开发记录
lw长期记忆.md                     # 28 条经验积累
realtime-asr-review.md            # 代码审查报告
review.md                         # 第二次审查（40 文件，10 个问题）
```

**这不是"文档癖"，而是 AI 辅助开发的最佳实践。**

为什么？因为 **AI 不会记住你上周改了什么东西。** 文档是给 AI（和自己）的上下文缓存：

- `architecture.md` → 新会话中让 AI 快速理解项目结构
- `lw长期记忆.md` → 踩过的坑不再踩第二次（"不要堵漏洞"）
- `开发文档.md` → 每次改了什么、为什么、怎么改的（变更日志即文档）
- `适配最低要求文档.md` → 部署 checklist，避免遗漏环境依赖

**经验：把文档当作"给下一个会话中的 AI 看的"。** 写文档不是为了归档，而是让你的下一次 `帮我修复 xxx` 命令能直接命中要害。

### 4.2 代码审查 = AI 时代的质量保险

项目中两次正式代码审查发现的问题：

- **🔴 严重问题**：异步任务路径分段 TTS 文件未注册（404）、TTS 全局单例 speaker 泄漏、REST 模式 TTS 阻塞 LLM 流
- **🟡 中等问题**：HttpTTSProvider 缺少公开 speaker 属性（说话人切换静默失效）、API Key 非恒定时间比较
- **🟢 结构性问题**：ChatPipeline 职责过重、全局状态散落、ScriptProcessor 过时

**这些问题的共同特征**：人类单独看代码看不出，但多角度交叉审查就能发现。

**经验：让 AI 做代码审查，用 5-7 个不同维度（bug 扫描、删除审计、跨文件追踪、复用简化、效率、安全、架构高度），每个维度独立审查。** 这比"帮我 review 一下"更有效。

### 4.3 测试策略：从"能跑就行"到"回归测试套件"

项目的测试演进：

```
阶段 1: 手动 curl 测试（"这个接口能不能用？"）
阶段 2: 单接口验证脚本（fortest/test_asr_streaming.py）
阶段 3: 完整回归测试（fortest/test_full_streaming.py，18 项）
阶段 4: 真实语音全链路测试（fortest/test_gateway_real_speech.py）
阶段 5: 批量对比测试（fortest/batch_test.py + CSV 结果）
```

**经验：AI 生成测试脚本极快。** 在 AI 辅助下，从"手动测试"到"18 项回归测试套件"可以在一天内完成。不值得花时间手动测第二次——第一次手动确认可行后，立刻让 AI 写成自动化脚本。

### 4.4 "小模型"项目的特殊性

realtime-asr 使用的模型：

| 模型 | 大小 | 定位 |
|------|------|------|
| Qwen3-ASR-0.6B | ~1.2GB | 轻量 ASR |
| Silero VAD | ~1MB | 极轻 VAD |
| Qwen3-TTS-0.6B | ~2GB | 轻量 TTS |
| DeepSeek/Kimi | 外部 API | 大模型 LLM |

**这类"小模型 + 大模型 API"架构的特点：**
- 本地推理的小模型决定延迟和服务可用性
- 外部 API 的大模型决定回复质量
- 自己做 ASR→LLM→TTS 全链路编排
- 不依赖大模型厂商的实时音频 API（如 GPT-4o Realtime）

**经验：小模型项目的核心竞争力是编排和可用性，而非模型本身。** ASR/TTS 模型用开源的 0.6B 小模型，LLM 调用外部 API，自研全链路流水线——这种"缝合"架构在成本和可控性之间取得了最佳平衡。

---

## 五、可复用的代码模式

### 5.1 双通道 WebSocket 协议

```python
# binary channel → 音频数据（低延迟，无序列化开销）
# text channel   → JSON 控制消息（llm_config, ping, reset, hotwords）

data = await ws.receive()
if "bytes" in data:
    pcm_bytes = data["bytes"]     # 16kHz PCM16
    await pipeline.process_audio_chunk(pcm_bytes)
elif "text" in data:
    msg = json.loads(data["text"])  # 控制协议
```

**适用场景**：实时音视频 + 信令控制。

### 5.2 寄存器模式（Registry Pattern）

```python
_ASR_REGISTRY: Dict[str, str] = {
    "qwen3": "backend.plugins.asr.qwen3_asr.Qwen3ASRProvider",
    "http_asr": "backend.plugins.asr.http_client.HttpASRProvider",
}

def get_asr(**override_kwargs) -> BaseASRProvider:
    name = get_settings().ASR_PROVIDER
    cls = _load_class(_ASR_REGISTRY[name])  # 动态导入
    return cls(**kwargs)
```

**适用场景**：任何需要"通过配置切换实现"的模块。

### 5.3 能力检测 + 自动降级

```python
@property
def supports_streaming(self) -> bool:
    if self._streaming_supported is None:
        self._detect_streaming_capability()  # 调 /capabilities 端点
    return self._streaming_supported

# Pipeline 中
if self.asr.supports_streaming:
    # 流式路径
else:
    # 降级到整段识别
```

**适用场景**：后端能力不确定时的优雅降级。

### 5.4 资源生命周期管理

```python
try:
    state = asr.init_streaming_state()
    # ... 使用 state ...
except Exception:
    # 降级
finally:
    if state is not None:
        try:
            asr.abort_streaming(state)  # cancel + close
        except Exception:
            pass  # 资源释放失败不应阻止程序退出
```

**适用场景**：任何涉及 GPU 资源或网络连接的操作。

---

## 六、AI 时代软件开发的流程思考

### 6.1 核心转变：从"写代码"到"做决策"

这个项目 7000+ 行代码，2 周完成——但真正花费时间的不是写代码，而是：

1. **架构决策**：插件的抽象粒度？Pipeline 的职责边界？流式/非流式如何共存？
2. **模型选型**：Qwen3-ASR-0.6B 还是 1.7B？vLLM 还是 from_pretrained？
3. **接口设计**：WebSocket 协议格式？OpenAI 兼容性到哪个程度？
4. **错误处理**：什么情况降级？什么情况报错？什么情况重试？
5. **资源管理**：GPU 显存分配策略？TTS 磁盘/内存模式？连接泄漏怎么防？

**经验：AI 让"实现"的成本趋近于零，但让"决策"的重要性倍增。** 在 AI 能一小时写完 500 行代码的时代，开发者的核心价值是判断这 500 行代码应该做什么、边界在哪里、异常怎么处理。

### 6.2 文档即代码，提示词即规范

项目中 `architecture.md` 的 985 行深度解析，完全可以作为给 AI 的系统提示词——事实上它就是。当你告诉 AI "按照 architecture.md 的架构设计，新增一个 xxx 功能"，AI 能产出高度一致的代码。

**经验：在 AI 时代，好的项目文档不只是给人看的——它是对齐人与 AI 认知的接口。** 结构清晰的架构文档 > 散落的代码注释 > 隐式的代码习惯。

### 6.3 测试从"负担"变成"加速器"

在 AI 辅助下，写一个 18 项回归测试脚本的成本从"半天"降到"10 分钟"。测试不再是"开发后的验证"，而是"开发中的护栏"——每次 AI 重构后，立刻跑测试，不对就回退。

**经验：AI 时代的测试优先级排序：**
1. 端到端 API 测试（最高 ROI，一次性覆盖所有接口）
2. 边界条件测试（非法输入、超时、空数据）
3. 单元测试（只在核心算法逻辑上写）

### 6.4 多角度代码审查不可替代

两次正式审查发现的问题中，至少 3 个在功能测试中无法发现（跨文件状态泄漏、异步路径 404、单例属性泄漏）。这些问题只有在"逐行扫描 + 删除审计 + 跨文件追踪 + 安全 + 效率 + 架构"的多维度审查下才会暴露。

**经验：AI 可以写代码，但需要另一个 AI（或不同角度的同一 AI）来审查代码。** 审查的维度越多样化，发现的隐藏问题越多。

---

## 七、一句话总结

> **AI 时代的小模型项目开发，核心不是"用 AI 写更多代码"，而是用插件化架构管理模型的不确定性，用文档建立人与 AI 的认知对齐，用多维度审查控制质量风险，让"换模型"和"改架构"成为改一行 `.env` 的事。**

---
