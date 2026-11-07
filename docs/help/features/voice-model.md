声音模型用于把桌宠的文字回复变成语音，是独立的可选功能。关闭语音后，文字聊天仍然可以正常使用。

## 配置本地声音模型

![声音模型资源配置页面](./images/voice-model-resources.png)

进入“语音系统 → 声音模型”，先填写“资源配置”，再连接 GPT-SoVITS 服务：

1. 选择与声音权重匹配的模型版本，支持 V1、V2、V3、V4、V2 Pro、V2 Pro Plus、V5 Dev 和 V5 Turbo。
2. 选择运行设备；电脑支持 CUDA 时，可以按实际环境选择 CUDA。
3. 根据页面提示选择 SoVITS 模型和 GPT 模型。它们需要来自同一套声音模型资源。
4. 如果想减少显存占用，可以打开“半精度推理”。

截图中的电脑文件位置和模型文件名已做隐私遮挡；实际使用时，请选择电脑上确实存在、应用可以读取的资源。

## 使用 V5

V5 分为 V5 Dev（`v5dev`）和 V5 Turbo（`v5turbo`），请按所用权重选择。先断开旧服务，再将本地根目录指向已更新且支持 V5 的 GPT-SoVITS 完整目录，选择对应的 SoVITS `.pth` 和 GPT `.ckpt` 文件，填写参考音频及文本后重新连接。

V5 运行目录需要包含 `GPT_SoVITS/module/models_v5.py` 和 `GPT_SoVITS/pretrained_models/gsv-v5-pretrained/vocoder.pth`。使用 LoRA 权重时，该预训练模型目录还需保留对应的 `s2Gv5dev.pth` 或 `s2Gv5turbo.pth` 底模；连接和桌宠包导入会检查这些依赖，缺失时按提示补齐。

V5 沿用官方 `api_v2.py` 的 `/tts` 接口，采样步数和引导参数采用服务端默认值：Turbo 为 4 步，Dev 为 32 步、`cfg_rate=1.3`。参考文本仍需填写。旧配置未指定版本时仍按 V2 Pro Plus 读取，不会自动改为 V5。

接口与依赖依据：[官方推理实现](https://github.com/RVC-Boss/GPT-SoVITS/blob/04a44eb977586645f33594b72af13a035a2056c6/GPT_SoVITS/TTS_infer_pack/TTS.py)、[官方 API](https://github.com/RVC-Boss/GPT-SoVITS/blob/04a44eb977586645f33594b72af13a035a2056c6/api_v2.py)。

## 设置参考音频和语音回复

![声音回复相关设置](./images/voice-model-output.png)

继续向下填写参考音频、参考文本和参考音频语言。参考音频需要是电脑上存在且应用能打开、时长约 3–10 秒的音频。确认服务连接成功后，再打开“启用语音回复”；关闭时仍会保留已填写的设置，只显示文字和字幕。

“首句就绪后输出”打开后，桌宠会等待第一句语音准备好再开始播放，适合希望文字和声音同步感更强的场景。

## 测试播放

保存后可以进行连接测试或试听。连接或试听失败时，页面会显示原因；取消操作不会把失败的设置当作已保存设置。
