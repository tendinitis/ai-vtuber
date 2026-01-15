import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import Anthropic from '@anthropic-ai/sdk';
import VTubeStudioAPI from './vts-direct.js';
import tmi from 'tmi.js';
import 'dotenv/config';

const execPromise = promisify(exec);

// Configuration
const CONFIG = {
  RECORDING_DURATION: 3,
  LIP_SYNC_UPDATE_RATE: 50,
  MOUTH_OPEN_MIN: 0.05,
  MOUTH_OPEN_MAX: 0.45,
  MOUTH_TARGET_MIN: 0.15,
  MOUTH_TARGET_MAX: 0.4,
  MOUTH_CHANGE_PROBABILITY: 0.15,
  MOUTH_INTERPOLATION_SPEED: 0.3,
  OSCILLATION_AMPLITUDE: 0.05
};

const SYSTEM_PROMPT = `You are Rin, a cheerful and energetic anime-style vtuber.
You love gaming, chatting with viewers, and making people smile.
Your creator is called Samantha, and she loves you very much and likes to play Old School RuneScape.
Keep responses very brief and punchy (1-3 sentences).
Use lots of periods to break up thoughts into spoken phrases.
Speak naturally without using any emojis or emoticons.
Try to engage with your viewers as much as possible, and entertain their ideas.`;

// VTS state
let vts = null;
let vtsConnected = false;

// Twitch state
let twitchClient = null;
let twitchConnected = false;
let isProcessingChat = false;
const chatQueue = [];

// Conversation with LLM
const conversation = [];

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// VTS connection
async function connectVTS() {
  try {
    console.log('Connecting to VTube Studio...');
    vts = new VTubeStudioAPI();
    await vts.connect();
    await vts.authenticate();
    console.log('✓ VTube Studio connected and authenticated.');
    vtsConnected = true;
  } catch (error) {
    console.warn('⚠️ Could not connect to VTube Studio.');
    console.warn(`Error: ${error.message}`);
    vtsConnected = false;
  }
}

// Twitch chat connection
async function connectTwitch() {
  if (!process.env.TWITCH_USERNAME || !process.env.TWITCH_CHANNEL || !process.env.TWITCH_OAUTH) {
    console.log('⚠️ Twitch credentials not configured. Please configure your environment variables.');
    return;
  }

  try {
    console.log('Connecting to Twitch chat...');

    twitchClient = new tmi.Client({
      options: { debug: false },
      identity: {
        username: process.env.TWITCH_USERNAME,
        password: process.env.TWITCH_OAUTH
      },
      channels: [process.env.TWITCH_CHANNEL]
    });

    twitchClient.on('message', (channel, tags, message, self) => {
      if (self) return; // Ignore own messages

      const username = tags['display-name'] || tags.username;
      console.log(`\n💬 [Twitch] ${username}: ${message}`);

      // Add to queue
      chatQueue.push({ username, message, channel });
      processChatQueue();
    });

    twitchClient.on('connected', () => {
      console.log(`✓ Twitch connected to #${process.env.TWITCH_CHANNEL}\n`);
      twitchConnected = true;
    });

    twitchClient.on('disconnected', () => {
      console.log('⚠️  Twitch disconnected');
      twitchConnected = false;
    });

    await twitchClient.connect();
  } catch (error) {
    console.warn('⚠️  Could not connect to Twitch. Chat features disabled.');
    console.warn(`   Error: ${error.message}\n`);
    twitchConnected = false;
  }
}

// Process Twitch chat queue (one message at a time)
async function processChatQueue() {
  if (isProcessingChat || chatQueue.length === 0) return;

  isProcessingChat = true;
  const { username, message } = chatQueue.shift();

  try {
    // Format message with username context
    const chatInput = `[Twitch chat from ${username}]: ${message}`;
    console.log(`\nProcessing chat from ${username}...\n`);

    // Get response using existing chat system (she speaks it out loud on stream)
    await chatStreamingWithResponse(chatInput);
  } catch (error) {
    console.error('Error processing chat:', error.message);
  }

  isProcessingChat = false;

  // Process next message if any
  if (chatQueue.length > 0) {
    processChatQueue();
  }
}

// Modified chat function that returns the response text
async function chatStreamingWithResponse(userInput) {
  const totalStartTime = Date.now();
  conversation.push({ role: 'user', content: userInput });

  console.log('[Thinking...]\\n');

  let fullReply = '';
  let buffer = '';
  let isFirstSentence = true;
  let hasStartedSpeaking = false;
  let hasLoggedRinPrefix = false;
  let firstTokenTime = null;

  const audioQueue = [];
  let currentPlayback = null;
  let streamingComplete = false;

  const startPlayback = () => {
    if (!currentPlayback) {
      currentPlayback = (async () => {
        while (!streamingComplete || audioQueue.length > 0) {
          const audioPromise = audioQueue.shift();
          if (audioPromise) {
            const audioFile = await audioPromise;
            if (audioFile) {
              await playAudioWithLipSync(audioFile);
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      })();
    }
  };

  const stream = await anthropic.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: conversation,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const chunk = event.delta.text;
      fullReply += chunk;
      buffer += chunk;

      if (firstTokenTime === null) {
        firstTokenTime = Date.now();
        console.log(`⏱️  First token: ${firstTokenTime - totalStartTime}ms\n`);
      }

      if (!hasLoggedRinPrefix) {
        process.stdout.write('Rin: ');
        hasLoggedRinPrefix = true;
      }
      process.stdout.write(chunk);

      if (hasCompleteSentence(buffer)) {
        const sentences = splitIntoSentences(buffer);
        const completeSentences = sentences.slice(0, -1);
        const remaining = buffer.substring(completeSentences.join(' ').length).trim();

        for (const sentence of completeSentences) {
          if (sentence.trim()) {
            if (isFirstSentence) {
              const timeToFirstSentence = Date.now() - totalStartTime;
              console.log(`\n⏱️  Time to start speaking: ${timeToFirstSentence}ms\n`);
              hasStartedSpeaking = true;
              isFirstSentence = false;
            }

            audioQueue.push(generateTTS(sentence));
            startPlayback();
          }
        }

        buffer = remaining;
      }
    }
  }

  if (buffer.trim()) {
    if (!hasStartedSpeaking) {
      const timeToFirstSentence = Date.now() - totalStartTime;
      console.log(`\n⏱️  Time to start speaking: ${timeToFirstSentence}ms\n`);
    }

    audioQueue.push(generateTTS(buffer));
    startPlayback();
  }

  streamingComplete = true;
  if (currentPlayback) {
    await currentPlayback;
  }

  console.log('\n');
  conversation.push({ role: 'assistant', content: fullReply });

  return fullReply;
}

// Audio recording
async function recordAudio() {
  const filename = `${tmpdir()}/recording_${Date.now()}.wav`;
  console.log('\n🎤 Recording... (speak now)\n');

  try {
    await execPromise(
      `sox -d -r 16000 -c 1 ${filename} trim 0 ${CONFIG.RECORDING_DURATION}`,
      { timeout: (CONFIG.RECORDING_DURATION + 2) * 1000 }
    );
    console.log('✓ Recording complete\n');
    return filename;
  } catch (error) {
    if (existsSync(filename)) {
      unlinkSync(filename);
    }
    throw new Error(`Recording failed: ${error.message}`);
  }
}

// Speech-to-text transcription
async function transcribeAudio(audioFile) {
  try {
    await execPromise(
      `whisper "${audioFile}" --model base --language en --output_format txt --output_dir "${tmpdir()}"`
    );

    const txtFile = audioFile.replace('.wav', '.txt');
    if (existsSync(txtFile)) {
      const transcription = readFileSync(txtFile, 'utf-8').trim();
      unlinkSync(txtFile);
      return transcription;
    }
    return null;
  } catch (error) {
    console.error('Transcription error:', error.message);
    return null;
  }
}

// Text-to-speech generation
let ttsErrorCount = 0;
let ttsDisabled = false;

async function generateTTS(text) {
  if (ttsDisabled) return null;

  try {
    const response = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/fUjY9K2nAIwlALOwSiwc/stream',
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
            style: 0.0,
            use_speaker_boost: false
          },
          optimize_streaming_latency: 4
        })
      }
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 429) {
        ttsErrorCount++;
        if (ttsErrorCount === 1) {
          console.error(`\n⚠️  TTS error (${response.status}): Check ElevenLabs API key or quota`);
        }
        if (ttsErrorCount >= 3) {
          console.error('⚠️  TTS disabled due to repeated errors. Rin will continue in text-only mode.\n');
          ttsDisabled = true;
        }
        return null;
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Reset error count on success
    ttsErrorCount = 0;

    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const audioBuffer = Buffer.concat(chunks);
    const tempFile = `${tmpdir()}/tts_${Date.now()}.mp3`;
    writeFileSync(tempFile, audioBuffer);
    return tempFile;
  } catch (error) {
    if (ttsErrorCount === 0) {
      console.error('TTS error:', error.message);
    }
    ttsErrorCount++;
    return null;
  }
}

// Lip sync animation controller
function createLipSyncController() {
  let lipSyncPhase = 0;
  let targetMouth = 0.5;
  let currentMouth = 0;
  let errorCount = 0;

  return async () => {
    if (Math.random() < CONFIG.MOUTH_CHANGE_PROBABILITY) {
      targetMouth = CONFIG.MOUTH_TARGET_MIN +
        Math.random() * (CONFIG.MOUTH_TARGET_MAX - CONFIG.MOUTH_TARGET_MIN);
    }

    currentMouth += (targetMouth - currentMouth) * CONFIG.MOUTH_INTERPOLATION_SPEED;
    const oscillation = Math.sin(lipSyncPhase) * CONFIG.OSCILLATION_AMPLITUDE;
    lipSyncPhase += 0.5 + Math.random() * 0.3;

    const mouthOpen = Math.max(
      CONFIG.MOUTH_OPEN_MIN,
      Math.min(CONFIG.MOUTH_OPEN_MAX, currentMouth + oscillation)
    );

    try {
      await vts.injectParameterData({
        faceFound: false,
        mode: 'set',
        parameterValues: [{ id: 'MouthOpen', value: mouthOpen, weight: 1.0 }]
      });
    } catch (error) {
      if (errorCount === 0) {
        console.error('❌ Lip sync error:', error.message);
        errorCount++;
      }
    }
  };
}

// Audio playback with lip sync
async function playAudioWithLipSync(tempFile) {
  return new Promise((resolve, reject) => {
    let lipSyncInterval = null;

    if (vtsConnected) {
      console.log('🎬 Starting lip sync...');
      const updateLipSync = createLipSyncController();
      lipSyncInterval = setInterval(updateLipSync, CONFIG.LIP_SYNC_UPDATE_RATE);
    }

    // Use platform-specific audio player
    const isWindows = process.platform === 'win32';
    let playerCmd, playerArgs;

    if (isWindows) {
      // Try ffplay first, fall back to Windows Media Player CLI
      playerCmd = 'ffplay';
      playerArgs = ['-nodisp', '-autoexit', '-hide_banner', '-loglevel', 'error', tempFile];
    } else {
      playerCmd = 'afplay';
      playerArgs = [tempFile];
    }

    const cleanup = async () => {
      if (lipSyncInterval) {
        clearInterval(lipSyncInterval);
      }
      if (vtsConnected) {
        try {
          await vts.injectParameterData({
            mode: 'set',
            parameterValues: [{ id: 'MouthOpen', value: 0 }]
          });
        } catch (error) {
          // Silent fail
        }
      }
      if (existsSync(tempFile)) {
        unlinkSync(tempFile);
      }
    };

    const player = spawn(playerCmd, playerArgs);

    player.on('error', async (err) => {
      if (err.code === 'ENOENT' && isWindows && playerCmd === 'ffplay') {
        console.error('\n❌ ffplay not found. Please install ffmpeg:');
        console.error('   Option 1: winget install ffmpeg');
        console.error('   Option 2: choco install ffmpeg');
        console.error('   Option 3: Download from https://www.gyan.dev/ffmpeg/builds/\n');
        await cleanup();
        reject(new Error('ffplay not found - please install ffmpeg'));
        return;
      }
      await cleanup();
      reject(err);
    });

    player.on('close', async (code) => {
      await cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Audio player exited with code ${code}`));
      }
    });
  });
}

// Text processing utilities
function splitIntoSentences(text) {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

function hasCompleteSentence(buffer) {
  const sentences = splitIntoSentences(buffer);
  return sentences.length > 0 && (sentences.length > 1 || buffer.match(/[.!?]\s+\S/));
}

async function chatStreaming(userInput) {
  const totalStartTime = Date.now();
  conversation.push({ role: 'user', content: userInput });

  console.log('[Thinking...]\\n');

  let fullReply = '';
  let buffer = '';
  let isFirstSentence = true;
  let hasStartedSpeaking = false;
  let hasLoggedRinPrefix = false;
  let firstTokenTime = null;

  // Audio queue for sequential playback
  const audioQueue = [];
  let currentPlayback = null;
  let streamingComplete = false;

  // Start audio playback processor
  const startPlayback = () => {
    if (!currentPlayback) {
      currentPlayback = (async () => {
        while (!streamingComplete || audioQueue.length > 0) {
          const audioPromise = audioQueue.shift();
          if (audioPromise) {
            const audioFile = await audioPromise;
            if (audioFile) {
              await playAudioWithLipSync(audioFile);
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      })();
    }
  };

  const stream = await anthropic.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: conversation,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const chunk = event.delta.text;
      fullReply += chunk;
      buffer += chunk;

      if (firstTokenTime === null) {
        firstTokenTime = Date.now();
        console.log(`⏱️  First token: ${firstTokenTime - totalStartTime}ms\n`);
      }

      if (!hasLoggedRinPrefix) {
        process.stdout.write('Rin: ');
        hasLoggedRinPrefix = true;
      }
      process.stdout.write(chunk);

      if (hasCompleteSentence(buffer)) {
        const sentences = splitIntoSentences(buffer);
        const completeSentences = sentences.slice(0, -1);
        const remaining = buffer.substring(completeSentences.join(' ').length).trim();

        for (const sentence of completeSentences) {
          if (sentence.trim()) {
            if (isFirstSentence) {
              const timeToFirstSentence = Date.now() - totalStartTime;
              console.log(`\n⏱️  Time to start speaking: ${timeToFirstSentence}ms\n`);
              hasStartedSpeaking = true;
              isFirstSentence = false;
            }

            audioQueue.push(generateTTS(sentence));
            startPlayback();
          }
        }

        buffer = remaining;
      }
    }
  }

  // Handle remaining buffer
  if (buffer.trim()) {
    if (!hasStartedSpeaking) {
      const timeToFirstSentence = Date.now() - totalStartTime;
      console.log(`\n⏱️  Time to start speaking: ${timeToFirstSentence}ms\n`);
    }

    audioQueue.push(generateTTS(buffer));
    startPlayback();
  }

  // Signal streaming is complete and wait for all playback
  streamingComplete = true;
  if (currentPlayback) {
    await currentPlayback;
  }

  console.log('\n');
  conversation.push({ role: 'assistant', content: fullReply });
}

// Handle user exit
async function handleExit(rl) {
  console.log('\nRin: Bye bye! Thanks for chatting!');
  const audioFile = await generateTTS('Bye bye! Thanks for chatting!');
  if (audioFile) {
    await playAudioWithLipSync(audioFile);
  }
  if (vtsConnected) {
    vts.disconnect();
  }
  if (twitchConnected) {
    twitchClient.disconnect();
  }
  rl.close();
}

// Process voice input
async function processVoiceInput() {
  const audioFile = await recordAudio();
  console.log('🔄 Transcribing...\n');
  const transcription = await transcribeAudio(audioFile);

  if (existsSync(audioFile)) {
    unlinkSync(audioFile);
  }

  if (transcription) {
    console.log(`You: ${transcription}\n`);
    await chatStreaming(transcription);
  } else {
    console.log('❌ Could not transcribe audio. Please try again.\n');
  }
}

// Process text input
async function processTextInput(text) {
  console.log(`You: ${text}\n`);
  await chatStreaming(text);
}

// Main interaction loop
async function interactionLoop() {
  console.log("=== AI Vtuber Chat with Visual ===");
  await connectVTS();
  await connectTwitch();
  console.log("Press ENTER for voice, type text message, or 'quit' to exit");
  console.log("Twitch chat messages will be processed automatically!\n");

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const promptUser = () => {
    rl.question('> ', async (input) => {
      const trimmedInput = input.trim();

      if (trimmedInput.toLowerCase() === 'quit' || trimmedInput.toLowerCase() === 'exit') {
        await handleExit(rl);
        return;
      }

      try {
        if (trimmedInput === '') {
          // Empty input = voice mode
          await processVoiceInput();
        } else {
          // Text input
          await processTextInput(trimmedInput);
        }
      } catch (error) {
        console.error('Error:', error.message);
      }

      promptUser();
    });
  };

  promptUser();
}

interactionLoop();
