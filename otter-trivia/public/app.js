'use strict';

(() => {
  const TOKEN_KEY = 'otterTriviaToken';
  const $ = (sel) => document.querySelector(sel);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cfg = null;
  let token = null;
  let quiz = null; // { questions, answers, score, total, status, result }
  let current = 0;

  // ---- storage (a convenience for resuming; the server is the record) ----
  const storage = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  };

  // ---- api ----
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      const err = new Error('Connection hiccup. Check your signal and try again.');
      err.network = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---- screens ----
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => {
      const on = s.dataset.screen === name;
      s.hidden = !on;
      if (on) {
        s.classList.remove('enter');
        void s.offsetWidth;
        s.classList.add('enter');
      }
    });
    $('#scorePill').hidden = name !== 'quiz';
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function buzz(ms) {
    if (navigator.vibrate) try { navigator.vibrate(ms); } catch { /* ignore */ }
  }

  // ---- config ----
  function applyConfig() {
    document.querySelectorAll('[data-cfg]').forEach((el) => {
      const v = cfg[el.dataset.cfg];
      if (v) el.textContent = v;
    });
    const rules = [
      'Free to play. Finish all 8 questions to get one raffle entry. One entry per person (per phone number).',
      cfg.raffleMinScore > 0
        ? `To be entered you need at least ${cfg.raffleMinScore} correct answers.`
        : 'Your score does not affect your chances: every finisher gets one equal entry.',
      `Prize: ${cfg.prizeName}. ${cfg.drawInfo}`,
      'The winner is picked at random by computer from all eligible entries, each with an equal chance. Not every participant wins.',
      cfg.winnerContact,
      'Your details are stored securely and only the Otter event team can see them. We use your name and number to run the raffle and contact the winner. We only contact you about Otter products if you opted in. To have your information deleted, ask at the Otter booth.',
    ];
    if (cfg.rulesExtra) rules.push(cfg.rulesExtra);
    const list = $('#rulesList');
    list.replaceChildren(...rules.map((r) => Object.assign(document.createElement('li'), { textContent: r })));
  }

  // ---- registration ----
  function normalizePhone(raw) {
    const input = String(raw || '').trim();
    if (!/^[+\d\s().\-]{7,25}$/.test(input)) return false;
    const digits = input.replace(/\D/g, '');
    if (input.startsWith('+')) {
      if (digits[0] === '1') return /^1[2-9]\d{2}[2-9]\d{6}$/.test(digits);
      return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0';
    }
    const n = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(n);
  }

  function setFieldError(name, msg) {
    const input = document.getElementById(name);
    const el = document.getElementById(`${name}-error`);
    if (el) el.textContent = msg || '';
    if (input) {
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (msg) input.setAttribute('aria-describedby', `${name}-error`);
    }
  }

  function clientValidate(v) {
    const errors = {};
    if (!v.fullName) errors.fullName = 'Please enter your name.';
    else if (v.fullName.length < 2 || !/\p{L}/u.test(v.fullName)) errors.fullName = 'Please enter your full name.';
    if (!v.phone) errors.phone = 'Please enter your phone number.';
    else if (!normalizePhone(v.phone)) errors.phone = 'Enter a valid phone number, e.g. (555) 123-4567.';
    return errors;
  }

  function formatPhoneOnBlur(e) {
    const d = e.target.value.replace(/\D/g, '');
    if (!e.target.value.trim().startsWith('+') && d.length === 10) {
      e.target.value = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    }
  }

  async function onRegister(e) {
    e.preventDefault();
    const form = e.target;
    const values = {
      fullName: form.fullName.value.trim().replace(/\s+/g, ' '),
      phone: form.phone.value.trim(),
      business: form.business.value.trim(),
      consent: form.consent.checked,
    };
    ['fullName', 'phone', 'business'].forEach((f) => setFieldError(f, ''));
    $('#form-error').textContent = '';

    const errors = clientValidate(values);
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([k, v]) => setFieldError(k, v));
      document.getElementById(Object.keys(errors)[0]).focus();
      buzz(30);
      return;
    }

    const btn = $('#startBtn');
    btn.disabled = true;
    btn.textContent = 'Getting your questions…';
    try {
      const data = await api('/api/register', { method: 'POST', body: values });
      token = data.token;
      storage.set(token);
      quiz = data.quiz;
      startQuiz();
    } catch (err) {
      if (err.status === 422 && err.data.fields) {
        Object.entries(err.data.fields).forEach(([k, v]) => setFieldError(k, v));
      } else if (err.status === 409) {
        $('#playedMsg').textContent = err.message;
        show('played');
      } else {
        $('#form-error').textContent = err.message;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start the Trivia Challenge';
    }
  }

  // ---- quiz ----
  const LETTERS = ['A', 'B', 'C', 'D'];

  function startQuiz() {
    if (quiz.status === 'completed') return showResults(quiz.result);
    current = quiz.answers.length;
    renderQuestion();
    show('quiz');
  }

  function updateProgress(answered) {
    const total = quiz.total;
    $('#progressFill').style.width = `${(answered / total) * 100}%`;
    $('#progressBar').setAttribute('aria-valuenow', String(answered));
    $('#progressBar').setAttribute('aria-valuemax', String(total));
    $('#scoreValue').textContent = String(quiz.score);
  }

  function renderQuestion() {
    const q = quiz.questions[current];
    $('#qCounter').textContent = `Question ${current + 1} of ${quiz.total}`;
    updateProgress(current);
    $('#questionText').textContent = q.prompt;
    $('#feedback').hidden = true;
    $('#nextBtn').hidden = true;
    $('#quiz-error').textContent = '';

    const wrap = $('#choices');
    wrap.replaceChildren();
    q.choices.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.dataset.id = c.id;
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = LETTERS[i];
      const text = document.createElement('span');
      text.className = 'choice-text';
      text.textContent = c.text;
      b.append(letter, text);
      b.addEventListener('click', () => onAnswer(c.id));
      wrap.append(b);
    });

    const card = $('#questionCard');
    card.classList.remove('slide-in');
    void card.offsetWidth;
    card.classList.add('slide-in');
  }

  let answering = false;
  async function onAnswer(choiceId) {
    if (answering) return;
    answering = true;
    const buttons = [...document.querySelectorAll('.choice')];
    buttons.forEach((b) => {
      b.disabled = true;
      if (b.dataset.id === choiceId) b.classList.add('picked');
    });
    $('#quiz-error').textContent = '';

    try {
      const res = await api('/api/answer', { method: 'POST', body: { index: current, choiceId } });
      quiz.answers[current] = { index: current, ...res };
      quiz.score = res.score;
      if (res.result) quiz.result = res.result;
      showFeedback(res, buttons);
    } catch (err) {
      if (err.status === 401) return resetToRegister('Your session expired. Please enter your details again.');
      if (err.data && err.data.code === 'out_of_order') return reloadQuiz();
      buttons.forEach((b) => { b.disabled = false; b.classList.remove('picked'); });
      $('#quiz-error').textContent = err.message;
    } finally {
      answering = false;
    }
  }

  function showFeedback(res, buttons) {
    const q = quiz.questions[current];
    buttons.forEach((b) => {
      b.classList.remove('picked');
      if (b.dataset.id === res.correctChoiceId) b.classList.add('correct');
      else if (b.dataset.id === res.choiceId) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const correctText = q.choices.find((c) => c.id === res.correctChoiceId).text;
    const fb = $('#feedback');
    fb.className = `feedback ${res.correct ? 'good' : 'bad'}`;
    $('#feedbackTitle').textContent = res.correct ? pick(['Nailed it! 🎉', 'Correct! 🙌', 'You got it! ✨']) : 'Not quite!';
    $('#feedbackAnswer').textContent = res.correct ? '' : `Correct answer: ${correctText}`;
    $('#feedbackAnswer').hidden = res.correct;
    $('#feedbackExpl').textContent = res.explanation;
    fb.hidden = false;
    updateProgress(current + 1);
    buzz(res.correct ? 20 : [30, 60, 30]);

    const last = current + 1 >= quiz.total;
    const next = $('#nextBtn');
    next.textContent = last ? 'See my results 🏆' : 'Next question →';
    next.hidden = false;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  function onNext() {
    if (current + 1 >= quiz.total) return showResults(quiz.result);
    current += 1;
    renderQuestion();
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    $('#questionText').focus({ preventScroll: true });
  }

  async function reloadQuiz() {
    try {
      quiz = await api('/api/quiz');
      startQuiz();
    } catch {
      resetToRegister();
    }
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---- results ----
  function showResults(result) {
    const { score, total } = result;
    $('#finalScore').textContent = '0';
    $('#finalTotal').textContent = String(total);
    const ratio = score / total;
    let title;
    let msg;
    if (score === total) { title = 'Perfect score! 🏆'; msg = 'You really know the restaurant business.'; }
    else if (ratio >= 0.75) { title = 'Impressive! 🔥'; msg = 'You know your way around a restaurant.'; }
    else if (ratio >= 0.5) { title = 'Nice work! 👏'; msg = 'Solid restaurant smarts.'; }
    else { title = 'Thanks for playing! 🙌'; msg = 'Every pro starts somewhere. Now you know a few new tricks.'; }
    $('#resultTitle').textContent = title;
    $('#resultMsg').textContent = `You scored ${score} out of ${total}. ${msg}`;

    if (result.raffleEligible) {
      $('#prizeBadge').textContent = '🎟️ You’re entered in the raffle!';
      $('#prizeMain').textContent = `You have one entry to win ${cfg.prizeName}.`;
      $('#entryCode').textContent = result.entryCode;
      $('#entryWrap').hidden = false;
    } else {
      $('#prizeBadge').textContent = 'Thanks for playing!';
      $('#prizeMain').textContent = `The raffle for ${cfg.prizeName} needs at least ${cfg.raffleMinScore} correct answers this time.`;
      $('#entryWrap').hidden = true;
    }
    show('results');

    const circumference = 2 * Math.PI * 52;
    const ring = $('#ringFg');
    ring.style.strokeDasharray = String(circumference);
    ring.style.strokeDashoffset = String(circumference);
    requestAnimationFrame(() => {
      ring.style.strokeDashoffset = String(circumference * (1 - ratio));
    });
    countUp($('#finalScore'), score);
    if (!reducedMotion) confetti();
  }

  function countUp(el, to) {
    if (reducedMotion || to === 0) { el.textContent = String(to); return; }
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / 900);
      el.textContent = String(Math.round(to * p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function confetti() {
    const canvas = $('#confetti');
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = (canvas.width = window.innerWidth * dpr);
    const h = (canvas.height = window.innerHeight * dpr);
    const colors = ['#1F5BFF', '#FFC53D', '#12B886', '#FF6B6B', '#7C5CFF'];
    const bits = Array.from({ length: 120 }, () => ({
      x: Math.random() * w,
      y: -Math.random() * h * 0.5,
      r: (4 + Math.random() * 5) * dpr,
      vy: (2 + Math.random() * 3) * dpr,
      vx: (Math.random() - 0.5) * 2 * dpr,
      a: Math.random() * Math.PI,
      va: (Math.random() - 0.5) * 0.2,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const end = performance.now() + 3500;
    const frame = (t) => {
      ctx.clearRect(0, 0, w, h);
      bits.forEach((b) => {
        b.x += b.vx; b.y += b.vy; b.a += b.va;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.a);
        ctx.fillStyle = b.c;
        ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2);
        ctx.restore();
      });
      if (t < end) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    };
    requestAnimationFrame(frame);
  }

  // ---- reset ----
  function resetToRegister(message) {
    token = null;
    quiz = null;
    storage.clear();
    const form = $('#registerForm');
    form.reset();
    ['fullName', 'phone', 'business'].forEach((f) => setFieldError(f, ''));
    $('#form-error').textContent = message || '';
    show('register');
  }

  // ---- boot ----
  async function boot() {
    $('#registerForm').addEventListener('submit', onRegister);
    $('#phone').addEventListener('blur', formatPhoneOnBlur);
    $('#nextBtn').addEventListener('click', onNext);
    $('#newPlayerBtn').addEventListener('click', () => {
      if (window.confirm('Start over for a new player? This only clears this screen. Your entry is saved.')) resetToRegister();
    });
    $('#backBtn').addEventListener('click', () => resetToRegister());
    document.querySelectorAll('[data-open-rules]').forEach((b) => b.addEventListener('click', () => {
      const d = $('#rulesDialog');
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }));

    try {
      cfg = await api('/api/config');
    } catch (err) {
      cfg = { prizeName: 'a prize', drawInfo: '', winnerContact: '', raffleMinScore: 0 };
      toast(err.message);
    }
    applyConfig();

    token = storage.get();
    if (token) {
      try {
        quiz = await api('/api/quiz');
        return startQuiz();
      } catch (err) {
        if (err.status === 401) storage.clear();
        token = null;
      }
    }
    show('register');
  }

  boot();
})();
