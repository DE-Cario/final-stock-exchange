/**
 * Utility functions for error handling, logging, and network management
 */

// ============ ERROR LOGGING ============
const ErrorLogger = {
  log: function(level, message, error = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}] [${level}]`;
    console.log(`${prefix} ${message}`, error || '');
    
    // Store errors in sessionStorage for debugging (last 50 errors)
    try {
      const key = 'cse_error_log';
      let logs = JSON.parse(sessionStorage.getItem(key) || '[]');
      logs.push({ timestamp, level, message, error: error?.message || error });
      logs = logs.slice(-50); // Keep last 50
      sessionStorage.setItem(key, JSON.stringify(logs));
    } catch (e) {
      // Ignore storage errors
    }
  },
  error: function(message, error) { this.log('ERROR', message, error); },
  warn: function(message) { this.log('WARN', message); },
  info: function(message) { this.log('INFO', message); },
  debug: function(message) { this.log('DEBUG', message); }
};

// ============ FETCH WITH TIMEOUT ============
function normalizeQtyValue(value, fallback = 1) {
  if (value === '' || value === null || value === undefined) return '';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      ErrorLogger.warn(`Request timeout (${timeoutMs}ms): ${url}`);
      throw new Error('Request timeout - server is taking too long to respond');
    }
    throw err;
  }
}

function renderTickerFromState(state, container) {
  if (!container) return;
  const companies = Array.isArray(state?.companies) ? state.companies : [];
  if (!companies.length) {
    container.innerHTML = '<span class="pct-flat">— 0.0%</span>';
    return;
  }

  const tickerItems = companies.map((company) => {
    const rawChange = Number(company.pctChangeThisBlock ?? company.pctChange ?? 0);
    const roundedChange = Math.round(rawChange * 10) / 10;
    const isUp = roundedChange > 0;
    const isDown = roundedChange < 0;
    const arrow = isUp ? '▲' : (isDown ? '▼' : '—');
    const cssClass = isUp ? 'tk-up' : (isDown ? 'tk-down' : 'pct-flat');
    return `<span>${company.name} <span class="${cssClass}">${arrow} ${Math.abs(roundedChange).toFixed(1)}%</span></span>`;
  });
  const repeatedItems = [...tickerItems, ...tickerItems];
  container.innerHTML = repeatedItems.join('');
}

// ============ SOCKET.IO ENHANCED ============
class SocketManager {
  constructor() {
    this.socket = null;
    this.listeners = {};
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.baseReconnectDelay = 1000; // 1 second
    this.isConnected = false;
  }

  connect() {
    if (this.socket) return;
    
    this.socket = io({
      reconnection: true,
      reconnectionDelay: this.baseReconnectDelay,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: this.maxReconnectAttempts
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      ErrorLogger.info('✓ Connected to server');
      this.emit('connected');
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
      ErrorLogger.warn('✗ Disconnected from server');
      this.emit('disconnected');
    });

    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      ErrorLogger.error(`Connection error (attempt ${this.reconnectAttempts}):`, error);
      this.emit('connection_error', error);
    });

    this.socket.on('error', (error) => {
      ErrorLogger.error('Socket error:', error);
      this.emit('socket_error', error);
    });

    // Proxy all other events to listeners
    this.socket.onAny((event, ...args) => {
      if (!['connect', 'disconnect', 'connect_error', 'error'].includes(event)) {
        this.emit(event, ...args);
      }
    });
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  emit(event, ...args) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => {
        try {
          cb(...args);
        } catch (err) {
          ErrorLogger.error(`Error in listener for event "${event}":`, err);
        }
      });
    }
  }

  send(event, data) {
    if (!this.socket || !this.isConnected) {
      ErrorLogger.warn(`Cannot send event "${event}" - socket not connected`);
      return;
    }
    this.socket.emit(event, data);
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
  }
}

// ============ LOADING INDICATOR ============
class LoadingIndicator {
  constructor() {
    this.count = 0;
    this.element = null;
    this.createElement();
  }

  createElement() {
    if (document.getElementById('loading-spinner')) return;
    const div = document.createElement('div');
    div.id = 'loading-spinner';
    div.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 9999;
      display: none;
      text-align: center;
    `;
    div.innerHTML = `
      <div style="
        border: 4px solid rgba(159, 216, 221, 0.2);
        border-top: 4px solid #00ff41;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        animation: spin 1s linear infinite;
        margin: 0 auto 10px;
      "></div>
      <div style="color: #00ff41; font-family: monospace;">Loading...</div>
    `;
    document.body.appendChild(div);
    this.element = div;
    
    // Add animation style if not present
    if (!document.getElementById('spinner-style')) {
      const style = document.createElement('style');
      style.id = 'spinner-style';
      style.textContent = `
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  show() {
    this.count++;
    if (this.element) this.element.style.display = 'block';
  }

  hide() {
    this.count = Math.max(0, this.count - 1);
    if (this.count === 0 && this.element) {
      this.element.style.display = 'none';
    }
  }
}

// ============ PAGINATION ============
class Paginator {
  constructor(items, itemsPerPage = 10) {
    this.allItems = items;
    this.itemsPerPage = itemsPerPage;
    this.currentPage = 1;
  }

  setItems(items) {
    this.allItems = items;
    this.currentPage = 1;
  }

  get totalPages() {
    return Math.ceil(this.allItems.length / this.itemsPerPage);
  }

  get currentItems() {
    const start = (this.currentPage - 1) * this.itemsPerPage;
    return this.allItems.slice(start, start + this.itemsPerPage);
  }

  goToPage(page) {
    this.currentPage = Math.max(1, Math.min(page, this.totalPages));
  }

  nextPage() {
    this.goToPage(this.currentPage + 1);
  }

  prevPage() {
    this.goToPage(this.currentPage - 1);
  }

  canNextPage() {
    return this.currentPage < this.totalPages;
  }

  canPrevPage() {
    return this.currentPage > 1;
  }
}

// Expose globally
if (typeof window !== 'undefined') {
  window.ErrorLogger = ErrorLogger;
  window.fetchWithTimeout = fetchWithTimeout;
  window.renderTickerFromState = renderTickerFromState;
  window.normalizeQtyValue = normalizeQtyValue;
  window.SocketManager = SocketManager;
  window.LoadingIndicator = LoadingIndicator;
  window.Paginator = Paginator;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ErrorLogger,
    fetchWithTimeout,
    renderTickerFromState,
    normalizeQtyValue,
    SocketManager,
    LoadingIndicator,
    Paginator
  };
}
