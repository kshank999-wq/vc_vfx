import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createBrowserBridge, type BrowserBridge } from './browser-bridge';
import './styles.css';
import './preview.css';

/**
 * Entry point for the browser preview at vc-vfx.com/preview. Installs the
 * browser bridge where the preload would have put `window.vcvfx`, and renders
 * the same App the desktop does under a slim banner that says what this is.
 */
const bridge = createBrowserBridge();
window.vcvfx = bridge;

function PreviewBanner({ api }: { api: BrowserBridge }) {
  return (
    <div className="preview-banner" role="note">
      <span>
        <strong>Browser preview</strong> — files stay in this browser. Download VC VFX for verification, plates and packaging.
      </span>
      <span className="preview-actions">
        <button type="button" className="link" onClick={() => api.command('save-as')} title="Download the open project as a .vcvfx file (Ctrl/Cmd+Shift+S)">
          Download project
        </button>
        <button type="button" className="link" onClick={() => api.command('open-project')} title="Open a .vcvfx project file (Ctrl/Cmd+Shift+O)">
          Open project file…
        </button>
        <button type="button" className="link" onClick={() => api.command('open-sample')}>
          Sample
        </button>
        <a className="link" href="/download">
          Download VC VFX
        </a>
      </span>
      {typeof __PREVIEW_BUILD__ === 'string' ? <span className="preview-build">{__PREVIEW_BUILD__}</span> : null}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <div className="preview-shell">
        <PreviewBanner api={bridge} />
        <div className="preview-app">
          <App api={bridge} />
        </div>
      </div>
    </StrictMode>,
  );
}
