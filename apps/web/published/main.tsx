// The read-only page of the knowledge store's Worker (ADR 0031, section 11), built by `bun run build` into
// dist/knowledge-worker/page and served by the Worker as its static assets.
import '@xyflow/react/dist/base.css';
import { createRoot } from 'react-dom/client';
import { PublishedPage } from './page';

createRoot(document.getElementById('root')!).render(<PublishedPage />);
