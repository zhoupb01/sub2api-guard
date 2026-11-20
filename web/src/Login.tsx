import { useState, type FormEvent } from "react";
import { api } from "./api";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSignedIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet login-sheet">
      <form className="frame login" onSubmit={submit}>
        <header className="plate"><span className="mark">SUB2API-GUARD<span>登录</span></span></header>
        <div className="login-body">
          <label className="field">
            <span className="field-k">密码</span>
            <input type="password" autoComplete="current-password" autoFocus required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
          {error && <p className="msg" data-kind="error" role="alert">{error}</p>}
        </div>
      </form>
    </div>
  );
}
