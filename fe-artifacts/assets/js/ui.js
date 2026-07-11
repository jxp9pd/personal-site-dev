// DOM/glue layer for auth: a header profile button + a dismissible login/signup
// modal. Pure UI — it never imports dataClient. All backend intent is delegated
// to callbacks (onLogin/onSignup/onLogout/onOpenProfile) supplied by the facade.
//
// Everything is scoped under a `pp-` prefix and ships its own stylesheet so it
// renders correctly on any page without depending on the host's CSS.

const STYLE_ID = 'pp-auth-style';
const DISMISS_KEY = 'pp-auth-dismissed';
const PROFILE_URL = '/profile.html';

// Homepage "paper" palette (mirrors /assets/site.css) so the widget matches the
// light theme on every host page. Fonts fall back gracefully if a page hasn't
// loaded the Google Fonts.
const FONT_MONO = '"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace';
const FONT_DISPLAY = '"Instrument Serif","Iowan Old Style",Georgia,serif';
const CSS = `
.pp-profile{position:relative;display:inline-flex}
.pp-profile-btn{background:transparent;border:1px solid #14130f;color:#14130f;
  padding:8px 16px;border-radius:999px;cursor:pointer;
  font:500 11px/1 ${FONT_MONO};text-transform:uppercase;letter-spacing:.14em;
  max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  transition:color .25s,background .25s,box-shadow .25s}
.pp-profile-btn:hover{color:#fdfcf3;background:#14130f;box-shadow:0 12px 30px -14px rgba(20,19,15,.55)}
.pp-menu{position:absolute;top:calc(100% + 8px);right:0;z-index:1000;min-width:160px;
  background:#fdfcf3;border:1px solid rgba(20,19,15,.14);border-radius:12px;padding:5px;
  box-shadow:0 18px 44px -20px rgba(20,19,15,.4)}
.pp-menu[hidden]{display:none}
.pp-menu-item{display:block;width:100%;text-align:left;background:none;border:0;
  color:#14130f;padding:9px 12px;border-radius:8px;cursor:pointer;
  font:500 11px/1 ${FONT_MONO};text-transform:uppercase;letter-spacing:.1em}
.pp-menu-item:hover{background:#f7f5ea}

.pp-overlay{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;
  justify-content:center;background:rgba(20,19,15,.4);padding:16px}
.pp-overlay[hidden]{display:none}
.pp-modal{position:relative;width:100%;max-width:360px;background:#fdfcf3;
  border:1px solid rgba(20,19,15,.14);border-radius:18px;padding:26px;color:#14130f;
  box-shadow:0 30px 70px -30px rgba(20,19,15,.5);font:15px/1.45 ${FONT_MONO}}
.pp-close{position:absolute;top:12px;right:14px;background:none;border:0;
  color:#6b675e;font-size:22px;line-height:1;cursor:pointer}
.pp-close:hover{color:#14130f}
.pp-title{margin:0 0 18px;font-family:${FONT_DISPLAY};font-size:26px;font-weight:400;letter-spacing:.01em}
.pp-field{margin-bottom:12px}
.pp-field[hidden]{display:none}
.pp-field label{display:block;font-size:10px;color:#6b675e;margin-bottom:6px;
  text-transform:uppercase;letter-spacing:.12em}
.pp-field input{width:100%;background:#f7f5ea;border:1px solid rgba(20,19,15,.22);color:#14130f;
  border-radius:10px;padding:10px 12px;font:14px/1.4 ${FONT_MONO}}
.pp-field input:focus{outline:none;border-color:#22b8ff;box-shadow:0 0 0 3px rgba(34,184,255,.15)}
.pp-msg{min-height:18px;font-size:13px;margin:2px 0 12px;color:#d64541}
.pp-msg[hidden]{display:none}
.pp-submit{width:100%;background:#14130f;border:1px solid #14130f;color:#fdfcf3;
  padding:11px;border-radius:999px;cursor:pointer;
  font:500 11px/1 ${FONT_MONO};text-transform:uppercase;letter-spacing:.14em;
  transition:background .25s,color .25s,box-shadow .25s}
.pp-submit:hover{background:transparent;color:#14130f;box-shadow:0 12px 30px -14px rgba(20,19,15,.55)}
.pp-submit:disabled{opacity:.5;cursor:default}
.pp-toggle{margin-top:16px;text-align:center;font-size:12px;color:#6b675e}
.pp-toggle-btn{background:none;border:0;color:#14130f;cursor:pointer;
  font:500 12px/1 ${FONT_MONO};padding:0 0 2px 5px;border-bottom:1px solid rgba(20,19,15,.28)}
.pp-toggle-btn:hover{border-bottom-color:#14130f}
`;

function injectStyleOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function createAuthUI({
  mountButtonInto,
  onLogin,
  onSignup,
  onLogout,
  onOpenProfile,
} = {}) {
  injectStyleOnce();

  let loggedIn = false;
  let signupMode = false;

  // ---- header button + menu ----
  const profile = document.createElement('div');
  profile.className = 'pp-profile';
  profile.innerHTML = `
    <button class="pp-profile-btn" type="button">Log in</button>
    <div class="pp-menu" hidden>
      <button class="pp-menu-item pp-menu-profile" type="button">Profile</button>
      <button class="pp-menu-item pp-menu-logout" type="button">Log out</button>
    </div>`;
  const profileBtn = profile.querySelector('.pp-profile-btn');
  const menu = profile.querySelector('.pp-menu');
  const menuProfile = profile.querySelector('.pp-menu-profile');
  const menuLogout = profile.querySelector('.pp-menu-logout');
  (mountButtonInto || document.body).appendChild(profile);

  // ---- modal ----
  const overlay = document.createElement('div');
  overlay.className = 'pp-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="pp-modal" role="dialog" aria-modal="true" aria-label="Sign in">
      <button class="pp-close" type="button" aria-label="Close">&times;</button>
      <h2 class="pp-title">Log in</h2>
      <form class="pp-form">
        <div class="pp-field pp-field-username" hidden>
          <label>Username</label>
          <input type="text" class="pp-username" autocomplete="username" autocapitalize="off">
        </div>
        <div class="pp-field">
          <label>Email</label>
          <input type="email" class="pp-email" autocomplete="email" autocapitalize="off">
        </div>
        <div class="pp-field">
          <label>Password</label>
          <input type="password" class="pp-password" autocomplete="current-password">
        </div>
        <div class="pp-msg" role="alert" hidden></div>
        <button class="pp-submit" type="submit">Log in</button>
      </form>
      <div class="pp-toggle">
        <span class="pp-toggle-text">No account?</span>
        <button class="pp-toggle-btn" type="button">Sign up</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const modal = overlay.querySelector('.pp-modal');
  const title = overlay.querySelector('.pp-title');
  const form = overlay.querySelector('.pp-form');
  const usernameField = overlay.querySelector('.pp-field-username');
  const usernameInput = overlay.querySelector('.pp-username');
  const emailInput = overlay.querySelector('.pp-email');
  const passwordInput = overlay.querySelector('.pp-password');
  const submitBtn = overlay.querySelector('.pp-submit');
  const msg = overlay.querySelector('.pp-msg');
  const toggleText = overlay.querySelector('.pp-toggle-text');
  const toggleBtn = overlay.querySelector('.pp-toggle-btn');
  const closeBtn = overlay.querySelector('.pp-close');

  // Always renders a plain string. A non-string (e.g. an Error whose `message`
  // is non-enumerable) would otherwise serialize to "{}" upstream.
  function showError(input) {
    let text = '';
    if (typeof input === 'string') {
      text = input;
    } else if (input != null) {
      text = typeof input.message === 'string'
        ? input.message
        : 'Something went wrong. Please try again.';
    }
    if (!text) {
      msg.textContent = '';
      msg.hidden = true;
      return;
    }
    msg.textContent = text;
    msg.hidden = false;
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    usernameInput.disabled = busy;
    emailInput.disabled = busy;
    passwordInput.disabled = busy;
    submitBtn.textContent = busy ? 'Working…' : signupMode ? 'Sign up' : 'Log in';
  }

  function setSignupMode(on) {
    signupMode = on;
    usernameField.hidden = !on;
    title.textContent = on ? 'Sign up' : 'Log in';
    submitBtn.textContent = on ? 'Sign up' : 'Log in';
    passwordInput.autocomplete = on ? 'new-password' : 'current-password';
    toggleText.textContent = on ? 'Have an account?' : 'No account?';
    toggleBtn.textContent = on ? 'Log in' : 'Sign up';
    showError('');
  }

  function openModal() {
    overlay.hidden = false;
    setTimeout(() => (signupMode ? usernameInput : emailInput).focus(), 0);
  }

  function closeModal() {
    overlay.hidden = true;
  }

  // A user-driven dismissal is remembered for the session so we don't re-nag on
  // later loads. `closeModal()` (e.g. after a successful login) does NOT set it.
  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode / storage disabled — dismissal just won't persist */
    }
    closeModal();
  }

  function wasDismissed() {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function maybeAutoPrompt() {
    if (loggedIn || wasDismissed()) return;
    openModal();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const username = usernameInput.value.trim();
    showError('');
    setBusy(true);
    try {
      if (signupMode) {
        await onSignup?.({ email, password, username });
      } else {
        await onLogin?.({ email, password });
      }
      closeModal();
    } catch (err) {
      showError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function setAuthState({ loggedIn: isLoggedIn, username } = {}) {
    loggedIn = !!isLoggedIn;
    menu.hidden = true;
    profileBtn.textContent = loggedIn ? username || 'Profile' : 'Log in';
    if (loggedIn) closeModal();
  }

  // ---- wiring ----
  form.addEventListener('submit', handleSubmit);
  closeBtn.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) dismiss();
  });
  toggleBtn.addEventListener('click', () => setSignupMode(!signupMode));

  profileBtn.addEventListener('click', () => {
    if (loggedIn) {
      menu.hidden = !menu.hidden;
    } else {
      setSignupMode(false);
      openModal();
    }
  });
  menuProfile.addEventListener('click', () => {
    menu.hidden = true;
    if (onOpenProfile) onOpenProfile();
    else window.location.href = PROFILE_URL;
  });
  menuLogout.addEventListener('click', async () => {
    menu.hidden = true;
    try {
      await onLogout?.();
    } catch {
      /* facade surfaces its own logout failures; header stays until auth event */
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !profile.contains(e.target)) menu.hidden = true;
  });

  return {
    openModal,
    closeModal,
    setAuthState,
    showError,
    setBusy,
    maybeAutoPrompt,
  };
}
