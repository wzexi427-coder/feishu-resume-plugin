const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ========== 配置区域 ==========
const CONFIG = {
  APP_ID: process.env.APP_ID || '你的_App_ID',
  APP_SECRET: process.env.APP_SECRET || '你的_App_Secret',
  // 飞书表格配置（用于更新状态）
  BASE_ID: process.env.BASE_ID || '',
  TABLE_ID: process.env.TABLE_ID || '',
  // 个人访问令牌（用于更新表格）
  PERSONAL_TOKEN: process.env.PERSONAL_TOKEN || ''
};

// 内存存储访问令牌
let accessToken = null;
let tokenExpireTime = 0;

// ========== 飞书日历 API 方法 ==========

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

// 获取本周日历事件
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
    // 获取日历列表
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
    const title = event.summary || '';
    
    // 匹配模式
    const patterns = [
      /面试[\-—:：]?\s*([^\-—:：\s]+)/i,
      /([^\-—:：\s]+)[\-—:：]?\s*面试/i,
      /初试[\-—:：]?\s*([^\-—:：\s]+)/i,
      /([^\-—:：\s]+)[\-—:：]?\s*初试/i,
      /面[\-—:：]?\s*([^\-—:：\s]{2,4})/i,
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

// ========== 更新飞书表格 ==========

// 使用多维表格 API 更新记录
async function updateRecordStatus(recordId, status) {
  try {
    // 使用 App Access Token 或 User Access Token
    const token = await getAccessToken();
    
    // 调用飞书多维表格 API 更新记录
    const res = await axios.put(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BASE_ID}/tables/${CONFIG.TABLE_ID}/records/${recordId}`,
      {
        fields: {
          "状态": status
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (res.data.code !== 0) {
      throw new Error(res.data.msg);
    }

    console.log(`✅ 成功更新记录 ${recordId} 状态为: ${status}`);
    return true;
  } catch (error) {
    console.error(`❌ 更新记录失败:`, error.message);
    // 如果失败，尝试使用个人访问令牌
    if (CONFIG.PERSONAL_TOKEN) {
      return await updateRecordWithPAT(recordId, status);
    }
    throw error;
  }
}

// 使用个人访问令牌更新（备用方案）
async function updateRecordWithPAT(recordId, status) {
  try {
    const res = await axios.put(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BASE_ID}/tables/${CONFIG.TABLE_ID}/records/${recordId}`,
      {
        fields: {
          "状态": status
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.PERSONAL_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (res.data.code !== 0) {
      throw new Error(res.data.msg);
    }

    console.log(`✅ 使用 PAT 成功更新记录 ${recordId}`);
    return true;
  } catch (error) {
    console.error(`❌ PAT 更新也失败:`, error.message);
    throw error;
  }
}

// ========== API 接口 ==========

// 健康检查
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'AI招聘助手插件运行中',
    version: '1.0.0'
  });
});

// 检查单个姓名
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
      status: matched ? '初试' : '简历未通过',
      calendarNamesFound: calendarNames
    });
  } catch (error) {
    console.error('❌ 检查失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Webhook 接口（供飞书自动化调用）
app.post('/webhook', async (req, res) => {
  try {
    const { recordId, name, tableId } = req.body;
    
    if (!recordId || !name) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    console.log(`🎯 Webhook 收到请求: recordId=${recordId}, name=${name}`);

    // 检查姓名是否在日历中
    const events = await getThisWeekCalendarEvents();
    const calendarNames = extractNamesFromEvents(events);
    const matched = isNameMatched(name, calendarNames);
    const newStatus = matched ? '初试' : '简历未通过';

    console.log(`📊 判断结果: ${name} -> ${newStatus}`);

    // 更新表格状态
    let updateResult = { success: false, message: '未配置表格更新' };
    
    if (CONFIG.BASE_ID && CONFIG.TABLE_ID) {
      try {
        await updateRecordStatus(recordId, newStatus);
        updateResult = { success: true, message: '状态已更新' };
      } catch (e) {
        updateResult = { success: false, message: e.message };
      }
    }

    res.json({
      success: true,
      name,
      matched,
      status: newStatus,
      updateResult
    });

  } catch (error) {
    console.error('❌ Webhook 处理失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 配置接口
app.get('/config', (req, res) => {
  res.json({
    appIdConfigured: !!CONFIG.APP_ID,
    baseIdConfigured: !!CONFIG.BASE_ID,
    tableIdConfigured: !!CONFIG.TABLE_ID
  });
});

// ========== 启动服务 ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 插件服务器启动: http://localhost:${PORT}`);
  console.log(`📋 健康检查: http://localhost:${PORT}/`);
  console.log(`🔔 Webhook: http://localhost:${PORT}/webhook`);
});