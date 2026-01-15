import WebSocket from 'ws';
import { existsSync, readFileSync, writeFileSync } from 'fs';

class VTubeStudioAPI {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.pluginName = 'AI VTuber';
    this.pluginDeveloper = 'Miku AI';
    this.tokenFile = '.vts_auth_token';
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://localhost:8001');

      this.ws.on('open', () => {
        console.log('✓ WebSocket connected to VTube Studio');
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        const response = JSON.parse(data.toString());

        // Handle both successful responses and errors
        if (response.requestID) {
          const handler = this.pendingRequests.get(response.requestID);
          if (handler) {
            this.pendingRequests.delete(response.requestID);

            if (response.messageType === 'APIError') {
              handler.reject(new Error(`API Error ${response.data.errorID}: ${response.data.message}`));
            } else if (response.data) {
              handler.resolve(response.data);
            } else {
              handler.reject(new Error('No data in response'));
            }
          }
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  }

  async sendRequest(messageType, data = {}) {
    const requestID = `req_${this.messageId++}`;
    const message = {
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID,
      messageType,
      data
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestID, { resolve, reject });
      this.ws.send(JSON.stringify(message));

      // Timeout after 30 seconds for auth requests, 2 seconds for others
      const timeout = messageType.includes('Authentication') ? 30000 : 2000;
      setTimeout(() => {
        if (this.pendingRequests.has(requestID)) {
          this.pendingRequests.delete(requestID);
          reject(new Error(`Request timeout for ${messageType}`));
        }
      }, timeout);
    });
  }

  loadToken() {
    try {
      if (existsSync(this.tokenFile)) {
        return readFileSync(this.tokenFile, 'utf-8').trim();
      }
    } catch (error) {
      // Ignore
    }
    return null;
  }

  saveToken(token) {
    try {
      writeFileSync(this.tokenFile, token);
    } catch (error) {
      console.warn('Could not save VTS auth token');
    }
  }

  async authenticate() {
    // Try to load existing token
    let token = this.loadToken();

    if (!token) {
      // Request new token
      console.log('⏳ Requesting auth token from VTube Studio...');
      console.log('   Please click "Allow" in VTube Studio\n');

      const tokenResponse = await this.sendRequest('AuthenticationTokenRequest', {
        pluginName: this.pluginName,
        pluginDeveloper: this.pluginDeveloper
      });

      token = tokenResponse.authenticationToken;
      this.saveToken(token);
      console.log('✓ Token received and saved');
    }

    // Authenticate with the token
    const authResponse = await this.sendRequest('AuthenticationRequest', {
      pluginName: this.pluginName,
      pluginDeveloper: this.pluginDeveloper,
      authenticationToken: token
    });

    if (authResponse.authenticated) {
      this.authenticated = true;
      return true;
    } else {
      throw new Error('Authentication failed: ' + authResponse.reason);
    }
  }

  async injectParameterData(params) {
    if (!this.authenticated) {
      throw new Error('Not authenticated with VTube Studio');
    }
    return this.sendRequest('InjectParameterDataRequest', params);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

export default VTubeStudioAPI;
