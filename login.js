const desktop = window.rewindDesktop;
const form = document.querySelector('#login-form');
const message = document.querySelector('#login-message');
const submit = document.querySelector('#login-submit');
const password = document.querySelector('#password');

let busy = false;

function setMessage(text, ok = false) {
  message.textContent = text;
  message.classList.toggle('ok', ok);
}

async function finish(user) {
  setMessage(`Signed in as @${user.username}. Opening Studio…`, true);
  setTimeout(() => window.close(), 650);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !desktop) return;
  busy = true;
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  setMessage('Connecting to api.rwd.2bd.net…');
  try {
    const result = await desktop.login({
      username: document.querySelector('#username').value,
      password: password.value
    });
    if (!result?.ok || !result.user) {
      setMessage(result?.error || 'That username or password is incorrect.');
      return;
    }
    await finish(result.user);
  } catch (error) {
    setMessage(error.message || 'Could not reach REWIND.');
  } finally {
    busy = false;
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

document.querySelector('#toggle-password').addEventListener('click', event => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  event.currentTarget.textContent = visible ? 'Show' : 'Hide';
});

document.querySelector('#continue-guest').addEventListener('click', () => window.close());
document.querySelector('#create-account').addEventListener('click', () => {
  desktop?.openExternal('https://rwd.2bd.net/');
});

desktop?.getConfig().then(config => {
  const label = document.querySelector('#api-label');
  if (label && config?.apiBase) label.textContent = config.apiBase.replace(/^https?:\/\//, '');
}).catch(() => {});

desktop?.authStatus().then(result => {
  if (result?.user) finish(result.user);
}).catch(() => {});
