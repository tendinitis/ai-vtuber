import { ApiClient } from 'vtubestudio';

console.log('Testing VTube Studio connection...\n');

const vts = new ApiClient({
  authTokenGetter: async () => null,
  authTokenSetter: async () => {},
  pluginName: 'VTS Connection Test',
  pluginDeveloper: 'Test',
});

// Wait a bit for connection
await new Promise(resolve => setTimeout(resolve, 2000));

console.log('Connection state:', vts.isConnected ? 'CONNECTED' : 'NOT CONNECTED');

if (vts.isConnected) {
  try {
    const state = await vts.apiState();
    console.log('API State:', state);
    console.log('\n✓ VTube Studio API is working!');
  } catch (error) {
    console.log('✗ Error calling API:', error.message);
  }
} else {
  console.log('\n✗ Could not connect to VTube Studio');
  console.log('\nPlease check:');
  console.log('1. VTube Studio is running');
  console.log('2. Settings → "Allow Plugins" is enabled');
  console.log('3. API is on port 8001 (check Settings → Plugins)');
}

process.exit(0);
