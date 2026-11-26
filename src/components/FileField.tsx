'use client';
import { upload } from '@vercel/blob/client';
import { useState } from 'react';

/**
 * File input that, when object storage is on, uploads the file straight from the browser to the clinic's private
 * store and posts only its key with the form (so files larger than the hosting body limit still work).
 * Without object storage it is a plain file input.
 */
export function FileField({ name, slug, tenantId, objectStorage, accept, required, label }: {
  name: string; slug: string; tenantId: string; objectStorage: boolean; accept?: string; required?: boolean; label?: string;
}) {
  const [state, setState] = useState<{ key?: string; fileName?: string; busy?: boolean; error?: string }>({});
  if (!objectStorage) return <input type="file" name={name} accept={accept} required={required} aria-label={label} />;
  return (
    <span className="file-field">
      <input type="file" accept={accept} required={required && !state.key} aria-label={label} disabled={state.busy}
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          setState({});
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) { setState({ error: 'Files must be 10 MB or smaller' }); e.currentTarget.value = ''; return; }
          setState({ busy: true });
          try {
            const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
            const b = await upload(`${tenantId}/uploads/${safe}`, file, { access: 'private', handleUploadUrl: `/api/uploads/${slug}`, contentType: file.type });
            setState({ key: b.pathname, fileName: file.name });
          } catch (err) {
            setState({ error: (err as Error).message || 'Upload failed' });
            e.currentTarget.value = '';
          }
        }} />
      {state.busy && <small className="muted"> Uploading…</small>}
      {state.key && <small className="muted"> Uploaded ✓</small>}
      {state.error && <small className="error"> {state.error}</small>}
      {state.key && <><input type="hidden" name={`${name}_key`} value={state.key} /><input type="hidden" name={`${name}_name`} value={state.fileName} /></>}
    </span>
  );
}
