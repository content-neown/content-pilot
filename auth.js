// ============================================
// AUTH.JS — Supabase Integration
// ContentPilot
// ============================================

const SUPABASE_URL = 'https://gwkvveltdfiiljfrrzih.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3a3Z2ZWx0ZGZpaWxqZnJyemloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMDMyMTUsImV4cCI6MjA5MDY3OTIxNX0.Wmqsu1HMsJFXtRuQtfNJW4rhCPEajNxtffiIKT_5bDc';

// _supabase is initialized after the SDK script loads (see each HTML page)
// We reference it via window._sb set in each page
function getSB() { return window._sb; }

// ============================================
// AUTH
// ============================================
const Auth = {
  getUser() {
    try { return JSON.parse(sessionStorage.getItem('cp_user') || 'null'); }
    catch { return null; }
  },

  async getUserAsync() {
    const sb = getSB();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
    const u = {
      id: user.id, email: user.email,
      name: profile?.name || user.email.split('@')[0],
      avatar: profile?.avatar || (profile?.name || user.email).charAt(0).toUpperCase()
    };
    sessionStorage.setItem('cp_user', JSON.stringify(u));
    return u;
  },

  async requireAuth() {
    const sb = getSB();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return null; }
    return await this.getUserAsync();
  },

  async login(email, password) {
    const sb = getSB();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    const u = await this.getUserAsync();
    return { success: true, user: u };
  },

  async signup(name, email, password) {
    const sb = getSB();
    const { data, error } = await sb.auth.signUp({
      email, password, options: { data: { name } }
    });
    if (error) return { success: false, error: error.message };
    if (data.user && !data.session) return { success: true, needsConfirmation: true };
    const u = await this.getUserAsync();
    return { success: true, user: u };
  },

  async logout() {
    const sb = getSB();
    await sb.auth.signOut();
    sessionStorage.removeItem('cp_user');
    window.location.href = 'index.html';
  },

  async getAllUsers() {
    const sb = getSB();
    const { data } = await sb.from('profiles').select('id, name, email, avatar');
    return data || [];
  }
};

// ============================================
// DB — All Supabase CRUD
// ============================================
const DB = {
  _uid() { return Auth.getUser()?.id || null; },
  sb() { return getSB(); },

  // TASKS
  async getTasks(filters = {}) {
    // FIX: removed .eq('user_id', this._uid()) — all team members see all tasks
    let q = this.sb().from('tasks').select('*').order('created_at', { ascending: false });
    if (filters.status) { const statuses = filters.status.split(','); if(statuses.length>1) q=q.in('status',statuses); else q=q.eq('status',filters.status); }
    if (filters.calType) q = q.eq('cal_type', filters.calType);
    if (filters.platform) q = q.eq('platform', filters.platform);
    const { data, error } = await q;
    if (error) { console.error(error); return []; }
    return (data || []).map(mapTask);
  },

  async saveTask(task) {
    const uid = this._uid();
    const payload = {
      title: task.title,
      description: task.description || null, script: task.script || null,
      platform: Array.isArray(task.platform) ? JSON.stringify(task.platform) : (task.platform || null),
      status: task.status || 'idea',
      cal_type: task.calType || 'social', pillar: task.pillar || null,
      structure: task.structure || null, objective: task.objective || null,
      assigned_date: task.assignedDate || null, deadline: task.deadline || null,
      live_date: task.liveDate || null, ref_link: task.refLink || null,
      live_link: task.liveLink || null, assignees: task.assignees || [], tags: task.tags || []
    };
    if (task.id) {
      // FIX: removed .eq('user_id', uid) — any team member can update any task
      const { data, error } = await this.sb().from('tasks').update(payload).eq('id', task.id).select().single();
      if (error) { console.error("saveTask UPDATE error:", error.message, error.details, error.hint, error.code); return null; }
      return mapTask(data);
    } else {
      // New task — stamp the creator's user_id
      payload.user_id = uid;
      const { data, error } = await this.sb().from('tasks').insert(payload).select().single();
      if (error) { console.error('saveTask INSERT error:', error.message, error.details, error.hint, error.code); return null; }
      return mapTask(data);
    }
  },

  async deleteTask(id) {
    // FIX: removed .eq('user_id', this._uid()) — any team member can delete any task
    const { error } = await this.sb().from('tasks').delete().eq('id', id);
    return !error;
  },

  // BANK ITEMS
  async getBankItems(filters = {}) {
    let q = this.sb().from('bank_items').select('*').eq('user_id', this._uid()).order('created_at', { ascending: false });
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.source) q = q.eq('source', filters.source);
    if (filters.platform) q = q.eq('platform', filters.platform);
    const { data, error } = await q;
    if (error) { console.error(error); return []; }
    return (data || []).map(mapBankItem);
  },

  async saveBankItem(item) {
    const uid = this._uid();
    const payload = {
      user_id: uid, title: item.title,
      description: item.description || null, script: item.script || null,
      platform: item.platform || null, status: item.status || 'idea',
      pillar: item.pillar || null, structure: item.structure || null,
      objective: item.objective || null, ref_link: item.refLink || null,
      live_link: item.liveLink || null, tags: item.tags || [], source: item.source || 'manual'
    };
    if (item.id) {
      const { data, error } = await this.sb().from('bank_items').update(payload).eq('id', item.id).eq('user_id', uid).select().single();
      if (error) { console.error(error); return null; }
      return mapBankItem(data);
    } else {
      const { data, error } = await this.sb().from('bank_items').insert(payload).select().single();
      if (error) { console.error(error); return null; }
      return mapBankItem(data);
    }
  },

  async deleteBankItem(id) {
    const { error } = await this.sb().from('bank_items').delete().eq('id', id).eq('user_id', this._uid());
    return !error;
  },

  // PERFORMANCE METRICS
  async getMetrics(filters = {}) {
    let q = this.sb().from('performance_metrics').select('*').eq('user_id', this._uid()).order('date', { ascending: false });
    if (filters.platform) q = q.eq('platform', filters.platform);
    const { data, error } = await q;
    if (error) { console.error(error); return []; }
    return (data || []).map(mapMetric);
  },

  async saveMetric(metric) {
    const uid = this._uid();
    const payload = {
      user_id: uid, task_id: metric.taskId || null,
      title: metric.title, platform: metric.platform || null, date: metric.date || null,
      views: metric.views || 0, likes: metric.likes || 0, comments: metric.comments || 0,
      shares: metric.shares || 0, saves: metric.saves || 0, reach: metric.reach || 0,
      clicks: metric.clicks || 0, leads: metric.leads || 0, conversions: metric.conversions || 0,
      spend: metric.spend || 0, revenue: metric.revenue || 0,
      watch_time: metric.watchTime || 0, avg_duration: metric.avgDuration || 0,
      followers_gained: metric.followers || 0, ctr: metric.ctr || 0,
      engagement_rate: metric.er || 0, notes: metric.notes || null
    };
    if (metric.id) {
      const { data, error } = await this.sb().from('performance_metrics').update(payload).eq('id', metric.id).eq('user_id', uid).select().single();
      if (error) { console.error(error); return null; }
      return mapMetric(data);
    } else {
      const { data, error } = await this.sb().from('performance_metrics').insert(payload).select().single();
      if (error) { console.error(error); return null; }
      return mapMetric(data);
    }
  },

  async deleteMetric(id) {
    const { error } = await this.sb().from('performance_metrics').delete().eq('id', id).eq('user_id', this._uid());
    return !error;
  },

  // CROSS-PAGE STATE (copywriter → calendar, bank → calendar)
  setPending(key, data) { sessionStorage.setItem('cp_pending_' + key, JSON.stringify(data)); },
  getPending(key) {
    try {
      const d = JSON.parse(sessionStorage.getItem('cp_pending_' + key) || 'null');
      sessionStorage.removeItem('cp_pending_' + key);
      return d;
    } catch { return null; }
  }
};

// ============================================
// MAPPERS — snake_case (Supabase) → camelCase (JS)
// ============================================
function mapTask(t) {
  if (!t) return null;
  let platform = t.platform;
  if (platform) {
    try { const p = JSON.parse(platform); platform = Array.isArray(p) ? p : [platform]; }
    catch { platform = [platform]; }
  } else { platform = []; }
  return {
    id: t.id, title: t.title, description: t.description, script: t.script,
    platform, status: t.status, calType: t.cal_type,
    pillar: t.pillar, structure: t.structure, objective: t.objective,
    assignedDate: t.assigned_date, deadline: t.deadline, liveDate: t.live_date,
    refLink: t.ref_link, liveLink: t.live_link,
    assignees: t.assignees || [], tags: t.tags || [],
    createdAt: t.created_at, updatedAt: t.updated_at
  };
}

function mapBankItem(i) {
  if (!i) return null;
  return {
    id: i.id, title: i.title, description: i.description, script: i.script,
    platform: i.platform, status: i.status, pillar: i.pillar,
    structure: i.structure, objective: i.objective,
    refLink: i.ref_link, liveLink: i.live_link,
    tags: i.tags || [], source: i.source,
    createdAt: i.created_at, updatedAt: i.updated_at
  };
}

function mapMetric(m) {
  if (!m) return null;
  return {
    id: m.id, title: m.title, platform: m.platform, date: m.date,
    views: m.views, likes: m.likes, comments: m.comments, shares: m.shares,
    saves: m.saves, reach: m.reach, clicks: m.clicks, leads: m.leads,
    conversions: m.conversions, spend: m.spend, revenue: m.revenue,
    watchTime: m.watch_time, avgDuration: m.avg_duration,
    followers: m.followers_gained, ctr: m.ctr, er: m.engagement_rate,
    notes: m.notes, createdAt: m.created_at
  };
}

// ============================================
// HELPERS
// ============================================
function showToast(message, type = 'info') {
  let toast = document.getElementById('global-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  const colors = { info: '#6c63ff', success: '#34d399', error: '#f87171', warning: '#fb923c' };
  toast.style.borderLeft = `3px solid ${colors[type] || colors.info}`;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function showLoading(msg = 'Loading...') {
  let el = document.getElementById('cp-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cp-loading';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,15,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;backdrop-filter:blur(4px)';
    el.innerHTML = `<div style="width:36px;height:36px;border:3px solid #2a2a3a;border-top-color:#6c63ff;border-radius:50%;animation:spin 0.7s linear infinite"></div><div style="font-size:14px;color:#a0a0c0;font-family:Satoshi,sans-serif">${msg}</div>`;
    document.body.appendChild(el);
  }
}

function hideLoading() {
  const el = document.getElementById('cp-loading');
  if (el) el.remove();
}

const STATUS_COLORS = {
  // Pre-Production
  'idea': 'tag-blue',
  'script-research': 'tag-indigo',
  'script-in-progress': 'tag-orange',
  'script-done': 'tag-teal',
  // Production
  'shoot-ready': 'tag-green',
  'shoot-in-progress': 'tag-orange',
  'shoot-done': 'tag-teal',
  'edit-in-progress': 'tag-orange',
  'edit-done': 'tag-green',
  // Post-Production
  'content-ready': 'tag-purple',
  'content-live': 'tag-pink',
  // Legacy / retained
  'review': 'tag-pink',
  'in-progress': 'tag-orange',
  'ready': 'tag-green',
  'live': 'tag-purple',
  'short': 'tag-red'
};

const STATUS_LABELS = {
  // Pre-Production
  'idea': 'Idea',
  'script-research': 'Script Research',
  'script-in-progress': 'Script In Progress',
  'script-done': 'Script Done',
  // Production
  'shoot-ready': 'Shoot Ready',
  'shoot-in-progress': 'Shoot In Progress',
  'shoot-done': 'Shoot Done',
  'edit-in-progress': 'Edit In Progress',
  'edit-done': 'Edit Done',
  // Post-Production
  'content-ready': 'Content Ready',
  'content-live': 'Content Live',
  // Legacy / retained
  'review': 'Review',
  'in-progress': 'In Progress',
  'ready': 'Ready',
  'live': 'Live',
  'short': 'Short'
};

// Grouped statuses for UI rendering
const STATUS_GROUPS = [
  {
    label: '🎬 Pre-Production',
    statuses: ['idea','script-research','script-in-progress','script-done']
  },
  {
    label: '🎥 Production',
    statuses: ['shoot-ready','shoot-in-progress','shoot-done','edit-in-progress','edit-done']
  },
  {
    label: '🚀 Post-Production',
    statuses: ['content-ready','content-live']
  }
];
