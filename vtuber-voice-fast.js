import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { spawn, exec } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { promisify } from 'util';

const execPromise = promisify(exec);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const systemPrompt = `You are Miku, a cheerful and energetic anime-style vtuber.
You love gaming, chatting with viewers, and making people smile.
Keep responses VERY brief and punchy (1-3 SHORT sentences).
Use lots of periods to break up thoughts into short, spoken phrases.
Speak naturally without using any emojis or emoticons.`;

const conversation = [];

// Recording duration in seconds - adjust based on your speaking pace
const RECORDING_DURATION = 3;

// Record audio from microphone for fixed duration
async function recordAudio() {
  const filename = `/tmp/recording_${Date.now()}.wav`;
  console.log('\n🎤 Recording... (speak now)\n');

  try {
    await execPromise(
      `sox -d -r 16000 -c 1 ${filename} trim 0 ${RECORDING_DURATION}`,
      { timeout: (RECORDING_DURATION + 2) * 1000 }
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

// Transcribe audio using local Whisper
async function transcribeAudio(audioFile) {
  try {
    await execPromise(`whisper "${audioFile}" --model base --language en --output_format txt --output_dir /tmp`);

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

// Generate TTS audio file (async, doesn't wait for playback)
async function generateTTS(text) {
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/fUjY9K2nAIwlALOwSiwc/stream', {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_turbo_v2_5',  // Good balance of speed and quality
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
          style: 0.0,
          use_speaker_boost: false
        },
        optimize_streaming_latency: 4  // Maximum optimization for speed
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const audioBuffer = Buffer.concat(chunks);
    const tempFile = `/tmp/tts_${Date.now()}.mp3`;
    writeFileSync(tempFile, audioBuffer);

    return tempFile;
  } catch (error) {
    console.error('TTS error:', error);
    return null;
  }
}

// Play audio file
function playAudio(tempFile) {
  return new Promise((resolve, reject) => {
    const player = spawn('afplay', [tempFile]);
    player.on('close', (code) => {
      unlinkSync(tempFile);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`afplay exited with code ${code}`));
      }
    });
    player.on('error', reject);
  });
}

function splitIntoSentences(text) {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

async function chatStreaming(userInput) {
  const totalStartTime = Date.now();
  conversation.push({ role: 'user', content: userInput });

  console.log('[Thinking...]\n');

  let fullReply = '';
  let buffer = '';
  let isFirstSentence = true;
  let hasStartedSpeaking = false;
  let hasLoggedMikuPrefix = false;
  let firstTokenTime = null;

  // Audio queue for sequential playback
  const audioQueue = [];
  let currentPlayback = null;

  const stream = await anthropic.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
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

      if (!hasLoggedMikuPrefix) {
        process.stdout.write('Miku: ');
        hasLoggedMikuPrefix = true;
      }
      process.stdout.write(chunk);

      // More aggressive: check for sentence endings even without following text
      const sentences = splitIntoSentences(buffer);

      // If we have sentences OR buffer ends with punctuation + space
      const hasCompleteSentence = sentences.length > 0 &&
        (sentences.length > 1 || buffer.match(/[.!?]\s+\S/));

      if (hasCompleteSentence) {
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

            // Start generating TTS immediately (don't wait)
            const audioPromise = generateTTS(sentence);
            audioQueue.push(audioPromise);

            // If nothing is playing, start playback immediately
            if (!currentPlayback) {
              currentPlayback = (async () => {
                while (audioQueue.length > 0 || buffer.length > 0) {
                  const nextAudio = await audioQueue.shift();
                  if (nextAudio) {
                    await playAudio(nextAudio);
                  } else {
                    // Small delay before checking again
                    await new Promise(resolve => setTimeout(resolve, 50));
                  }
                }
                currentPlayback = null;
              })();
            }
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

    const audioPromise = generateTTS(buffer);
    audioQueue.push(audioPromise);

    if (!currentPlayback) {
      currentPlayback = (async () => {
        while (audioQueue.length > 0) {
          const nextAudio = await audioQueue.shift();
          if (nextAudio) {
            await playAudio(nextAudio);
          }
        }
        currentPlayback = null;
      })();
    }
  }

  // Wait for all playback to finish
  if (currentPlayback) {
    await currentPlayback;
  }

  console.log('\n');
  conversation.push({ role: 'assistant', content: fullReply });
}

async function voiceLoop() {
  console.log("=== AI Vtuber Voice Chat (FAST) ===");
  console.log("Press ENTER to start recording, or 'quit' to exit\n");

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const askForInput = () => {
    rl.question('Press ENTER to record (or "quit" to exit): ', async (input) => {
      if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
        console.log('\nMiku: Bye bye! Thanks for chatting!');
        const audioFile = await generateTTS('Bye bye! Thanks for chatting!');
        if (audioFile) await playAudio(audioFile);
        rl.close();
        return;
      }

      try {
        const audioFile = await recordAudio(5);
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
      } catch (error) {
        console.error('Error:', error.message);
      }

      askForInput();
    });
  };

  askForInput();
}

voiceLoop();
