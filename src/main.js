import { Game } from './game/Game.js';

// Global error handler
window.addEventListener('error', (e) => {
  console.error('Global error:', e.error);
  const loading = document.getElementById('loading');
  if (loading && !loading.classList.contains('hidden')) {
    loading.innerHTML = `
      <div class="loading-content">
        <h2 style="color: #e94560;">Error Loading Game</h2>
        <p style="color: #ff6b6b; margin-top: 10px;">${e.message}</p>
        <p style="color: #999; margin-top: 20px; font-size: 0.9rem;">Check the browser console for details.</p>
        <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 30px; background: #e94560; color: #fff; border: none; border-radius: 5px; cursor: pointer;">Reload</button>
      </div>
    `;
  }
});

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
});

// Main entry point
const game = new Game();
game.init();
