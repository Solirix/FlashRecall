// #/login — centered card, login/register toggle, inline server errors.

import { api } from '../api.js';
import { el, icon, sleep, motionOK, passwordField } from '../ui.js';
import { state, applyTheme, refreshDecks, navigate } from '../app.js';

export async function render(main) {
  let mode = 'login';
  // Offer sign-up only when the server has it open; assume open if health fails.
  const registrationOpen = await api.get('/api/health')
    .then((h) => h.registrationOpen !== false, () => true);

  const title = el('h2', {});
  const form = el('div', {});
  const card = el('div', { class: 'auth-card enter' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-logo', html: icon('bolt', 17) }),
      el('div', {},
        el('div', { class: 'brand-name', text: 'RECALL' }),
        el('div', { class: 'brand-tag', text: 'flashcards, fast' }))),
    title, form);

  // Replay a one-shot CSS animation class on the card.
  function play(cls) {
    card.classList.remove(cls);
    void card.offsetWidth; // restart the animation if it's already applied
    card.classList.add(cls);
  }

  async function onSuccess(me, submit) {
    if (motionOK()) {
      submit.innerHTML = icon('check', 18);
      play('success');
      await sleep(380);
    }
    state.user = me;
    state.settings = me.settings;
    applyTheme(me.settings);
    await refreshDecks().catch(() => {});
    navigate('#/home');
  }

  function field(labelText, input) {
    return el('div', { class: 'field' }, el('label', { text: labelText }), input);
  }

  function renderForm() {
    form.innerHTML = '';
    const errBox = el('div', { class: 'form-error', role: 'alert' });
    const username = el('input', { type: 'text', autocomplete: 'username', required: true });
    const password = el('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });

    async function submitAuth(path, body, submit) {
      errBox.textContent = '';
      submit.disabled = true;
      submit.classList.add('busy');
      try {
        const me = await api.post(path, body);
        submit.classList.remove('busy');
        await onSuccess(me, submit);
      } catch (err) {
        errBox.textContent = (err && err.message) || 'request failed';
        play('shake');
        password.select();
      } finally {
        submit.disabled = false;
        submit.classList.remove('busy');
      }
    }

    if (mode === 'login') {
      title.textContent = 'Sign in to RECALL';
      const submit = el('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%' }, 'Sign in');
      form.append(
        el('form', {
          onsubmit: (e) => {
            e.preventDefault();
            submitAuth('/api/login', { username: username.value.trim(), password: password.value }, submit);
          },
        }, field('Username', username), field('Password', passwordField(password)), errBox, submit),
        ...(registrationOpen ? [el('p', { class: 'auth-toggle' },
          'No account yet? ',
          el('a', { href: '#/login', onclick: (e) => { e.preventDefault(); mode = 'register'; renderForm(); } }, 'Create account'))] : []));
      username.focus();
      return;
    }

    title.textContent = 'Create your account';
    const displayName = el('input', { type: 'text', autocomplete: 'nickname' });
    const password2 = el('input', { type: 'password', autocomplete: 'new-password', required: true });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%' }, 'Create account');
    form.append(
      el('form', {
        onsubmit: (e) => {
          e.preventDefault();
          if (password.value.length < 8) { errBox.textContent = 'password must be at least 8 characters'; return; }
          if (password.value !== password2.value) { errBox.textContent = 'passwords do not match'; return; }
          submitAuth('/api/register', {
            username: username.value.trim(),
            displayName: displayName.value.trim() || undefined,
            password: password.value,
          }, submit);
        },
      },
      field('Username', username),
      field('Display name (optional)', displayName),
      field('Password (min 8 chars)', passwordField(password)),
      field('Repeat password', passwordField(password2)),
      errBox, submit),
      el('p', { class: 'auth-toggle' },
        'Already have an account? ',
        el('a', { href: '#/login', onclick: (e) => { e.preventDefault(); mode = 'login'; renderForm(); } }, 'Sign in')));
    username.focus();
  }

  renderForm();
  main.append(el('div', { class: 'auth-wrap' }, card));
}
