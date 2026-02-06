const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ========== 配置区域（之后需要修改） ==========
const CONFIG = {
  APP_ID: 'cli_a8b5120172a2101c',
  APP_SECRET: 'odDmS9JktPW1QxF4k0JXycZ0C7gdNoO0',
  // 表格字段配置
  NAME_FIELD: '姓名',
  STATUS_FIELD: '状态',
  STATUS_INITIAL: '初试',
  STATUS_REJECTED: '简历未通过'
};

// 内存存储访问令牌
let accessToken = null;
let tokenExpireTime = 0;

// ========== 飞书 API 方法 ==========

// 获取 tenant_access_token
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpireTime) {
    return accessToken;
  }

  try {
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: CONFIG.APP_ID,
      app_secret: CONFIG.APP_SECRET
    });

    if (res.data.code !== 0) {
      throw new Error(res.data.msg);
    }

    accessToken = res.data.tenant_access_token;
    tokenExpireTime = Date.now() + (res.data.expire - 300) * 1000;
    console.log('✅ 获取 access_token 成功');
    return accessToken;
  } catch (error) {
    console.error('❌ 获取 access_token 失败:', error.message);
    throw error;
  }
}

// 获取本周日历事件（简化版，先获取当前用户的日历列表）
async function getThisWeekCalendarEvents() {
  const token = await getAccessToken();
  
  // 计算本周一和周日
  const now = new Date();
  const dayOfWeek = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + 1);
  monday.setHours(0, 0, 0, 0);
  
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const timeMin = monday.toISOString();
  const timeMax = sunday.toISOString();

  console.log(`📅 查询本周日历: ${monday.toLocaleDateString()} 至 ${sunday.toLocaleDateString()}`);

  try {
    // 先获取日历列表
    const calendarsRes = await axios.get('https://open.feishu.cn/open-apis/calendar/v4/calendars', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (calendarsRes.data.code !== 0) {
      throw new Error(calendarsRes.data.msg);
    }

    const calendars = calendarsRes.data.data?.calendar_list || [];
    console.log(`📋 找到 ${calendars.length} 个日历`);

    // 获取每个日历的事件
    let allEvents = [];
    for (const calendar of calendars) {
      try {
        const eventsRes = await axios.get(
          `https://open.feishu.cn/open-apis/calendar/v4/calendars/${calendar.calendar_id}/events?` +
          `time_min=${encodeURIComponent(timeMin)}&` +
          `time_max=${encodeURIComponent(timeMax)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );

        if (eventsRes.data.code === 0) {
          const events = eventsRes.data.data?.items || [];
          allEvents = allEvents.concat(events);
        }
      } catch (e) {
        console.log(`⚠️ 获取日历 ${calendar.calendar_id} 事件失败`);
      }
    }

    console.log(`📅 本周共 ${allEvents.length} 个事件`);
    return allEvents;
  } catch (error) {
    console.error('❌ 获取日历失败:', error.message);
    return [];
  }
}

// 从日历事件中提取姓名
function extractNamesFromEvents(events) {
  const names = new Set();

  events.forEach(event => {
    // 从标题提取
    const title = event.summary || '';
    
    // 匹配模式：面试-张三、张三-面试、初试-张三 等
    const patterns = [
      /面试[\-—:：]?\s*([^\-—:：\s]+)/i,
      /([^\-—:：\s]+)[\-—:：]?\s*面试/i,
      /初试[\-—:：]?\s*([^\-—:：\s]+)/i,
      /([^\-—:：\s]+)[\-—:：]?\s*初试/i,
      /面[\-—:：]?\s*([^\-—:：\s]{2,4})/i,  // 面-张三 或 面：张三
    ];

    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match && match[1]) {
        names.add(match[1].trim());
        break;
      }
    }

    // 从参与者提取
    const attendees = event.attendees || [];
    attendees.forEach(attendee => {
      if (attendee.display_name) {
        names.add(attendee.display_name.trim());
      }
    });
  });

  const result = Array.from(names);
  console.log('🔍 从日历提取的姓名:', result);
  return result;
}

// 检查姓名是否匹配
function isNameMatched(name, calendarNames) {
  const cleanName = name.trim();
  return calendarNames.some(calName => {
    if (calName === cleanName) return true;
    if (calName.includes(cleanName) || cleanName.includes(calName)) return true;
    if (calName.replace(/\s/g, '') === cleanName.replace(/\s/g, '')) return true;
    return false;
  });
}

// ========== 插件 API 接口 ==========

// 健康检查
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'AI招聘助手插件运行中',
    version: '1.0.0'
  });
});

// 检查单个姓名是否在本周日历中
app.post('/check-name', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: '缺少姓名参数' });
    }

    console.log(`🔍 检查姓名: ${name}`);
    const events = await getThisWeekCalendarEvents();
    const calendarNames = extractNamesFromEvents(events);
    const matched = isNameMatched(name, calendarNames);

    res.json({
      name,
      matched,
      status: matched ? CONFIG.STATUS_INITIAL : CONFIG.STATUS_REJECTED,
      calendarNamesFound: calendarNames
    });
  } catch (error) {
    console.error('❌ 检查失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 获取配置信息（供前端使用）
app.get('/config', (req, res) => {
  res.json({
    nameField: CONFIG.NAME_FIELD,
    statusField: CONFIG.STATUS_FIELD,
    statusInitial: CONFIG.STATUS_INITIAL,
    statusRejected: CONFIG.STATUS_REJECTED
  });
});

// 更新配置
app.post('/config', (req, res) => {
  const { appId, appSecret } = req.body;
  if (appId) CONFIG.APP_ID = appId;
  if (appSecret) CONFIG.APP_SECRET = appSecret;
  res.json({ message: '配置已更新' });
});

// ========== 启动服务 ==========
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 插件服务器启动: http://localhost:${PORT}`);
  console.log(`📋 健康检查: http://localhost:${PORT}/`);
  console.log(`⚙️  配置接口: http://localhost:${PORT}/config`);
});