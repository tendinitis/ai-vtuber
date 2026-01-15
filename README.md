# AI VTuber - Miku

Voice-to-voice AI VTuber with minimal latency, optimized for real-time interaction.

## Current Implementation

**File:** `vtuber-voice-fast.js`

### Features
- Voice-to-voice interaction (speak and get voice responses)
- Local Whisper STT (base model for speed)
- Claude Haiku 4.5 for fast LLM responses (~200-500ms first token)
- ElevenLabs Turbo v2.5 TTS with streaming
- Sentence-by-sentence audio generation and playback
- Pipelined audio generation (next sentence generates while current plays)
- ~1-2 second total latency from end of speech to start of response

### Dependencies
- Node.js
- sox (audio recording)
- whisper (local speech-to-text)
- ffmpeg (required by whisper)

### Environment Variables
Create a `.env` file with:
```
ANTHROPIC_API_KEY=your_key_here
ELEVENLABS_API_KEY=your_key_here
```

### Running
```bash
node vtuber-voice-fast.js
```

## Configuration

### Recording Duration
```javascript
const RECORDING_DURATION = 3; // seconds
```

### TTS Settings
- Model: `eleven_turbo_v2_5`
- Voice: Custom voice ID in code
- Latency optimization: Level 4 (max speed)

## Next Steps for Desktop with GPU

### Local LLM Options
1. **Llama 3.2** with Ollama
   ```bash
   ollama run llama3.2
   ```

2. **LM Studio** - GUI for running local models
   - Download from: https://lmstudio.ai
   - Recommended: Llama 3.2 3B or 8B for speed

3. **vLLM** - High-performance inference
   ```bash
   pip install vllm
   ```

### Benefits of Local LLM
- Zero API costs
- No rate limits
- Lower latency (with good GPU)
- Full privacy

### Recommended Models for Real-Time
- **Llama 3.2 3B** - Fastest, decent quality
- **Phi-3 Mini** - Good balance
- **Mistral 7B** - Higher quality, slightly slower

## Performance Metrics

Current latency breakdown:
- Recording: 3 seconds (fixed)
- Whisper transcription: ~1-2 seconds
- Claude Haiku first token: ~200-500ms
- TTS generation: ~300-500ms per sentence
- Total: ~4-6 seconds end-to-end

Target with local LLM:
- Recording: 3 seconds (fixed)
- Whisper: ~1-2 seconds
- Local LLM: ~100-300ms (with good GPU)
- TTS: ~300-500ms
- Total: ~3-5 seconds end-to-end
