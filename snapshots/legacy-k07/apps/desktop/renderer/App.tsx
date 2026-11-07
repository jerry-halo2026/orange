export function App() {
  // No first-party session verifier exists in T01. All paths intentionally
  // render only the startup gate, without cached content or demo roles.
  return (
    <main>
      <h1>橙子创作中心</h1>
      <p role="status">尚无经过验证的橙子会话。第一方登录接入后，请联网登录再进入创作工作区。</p>
    </main>
  );
}
