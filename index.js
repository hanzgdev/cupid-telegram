const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');

const bot = new TelegramBot(process.env.TOKEN, { polling: true });
const db = new Database('cupid.db');

const ADMIN_ID = process.env.ADMIN_ID ? process.env.ADMIN_ID.toString().trim() : null;
const DAILY_LIKE_LIMIT = 10;

function isAdmin(id) {
  return id.toString().trim() === ADMIN_ID;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    name TEXT,
    age INTEGER,
    gender TEXT,
    looking_for TEXT,
    bio TEXT,
    interests TEXT,
    photo_id TEXT,
    is_vip INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    boosted_until INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS likes (
    from_id INTEGER,
    to_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (from_id, to_id)
  );
  CREATE TABLE IF NOT EXISTS passes (
    from_id INTEGER,
    to_id INTEGER,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE TABLE IF NOT EXISTS last_seen (
    user_id INTEGER PRIMARY KEY,
    last_match_id INTEGER
  );
`);

const sessions = {};

function mainMenu(userId) {
  const profile = db.prepare('SELECT is_vip FROM profiles WHERE user_id = ?').get(userId);
  const vip = profile && profile.is_vip === 1;
  return {
    reply_markup: {
      keyboard: [
        ['💘 Find a Match'],
        ['👤 My Profile', '✏️ Edit Profile'],
        ['💌 Who Liked Me', vip ? '⭐ VIP Member' : '⭐ Get VIP'],
        ['🗑️ Delete Profile']
      ],
      resize_keyboard: true
    }
  };
}

function isVip(userId) {
  const profile = db.prepare('SELECT is_vip FROM profiles WHERE user_id = ?').get(userId);
  return profile && profile.is_vip === 1;
}

function isBanned(userId) {
  const profile = db.prepare('SELECT is_banned FROM profiles WHERE user_id = ?').get(userId);
  return profile && profile.is_banned === 1;
}

function getLikesUsedToday(userId) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const row = db.prepare('SELECT COUNT(*) as count FROM likes WHERE from_id = ? AND created_at > ?').get(userId, since);
  return row.count;
}

function finishProfile(userId, username) {
  const s = sessions[userId];
  const existing = db.prepare('SELECT is_vip, boosted_until FROM profiles WHERE user_id = ?').get(userId);
  db.prepare(`
    INSERT OR REPLACE INTO profiles (user_id, username, name, age, gender, looking_for, bio, interests, photo_id, is_vip, boosted_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    username || null,
    s.name,
    s.age,
    s.gender,
    s.looking_for,
    s.bio,
    s.interests,
    s.photo_id || null,
    existing ? existing.is_vip : 0,
    existing ? existing.boosted_until : 0
  );
  delete sessions[userId];
}

function showMatch(id) {
  const me = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
  if (!me) {
    return bot.sendMessage(id, 'You need a profile first!', {
      reply_markup: { keyboard: [['💘 Create Profile']], resize_keyboard: true }
    });
  }

  const genderFilter = me.looking_for === 'Everyone' ? '%' : me.looking_for.slice(0, -1);
  const now = Math.floor(Date.now() / 1000);

  const match = db.prepare(`
    SELECT * FROM profiles
    WHERE user_id != ?
    AND is_banned = 0
    AND gender LIKE ?
    AND user_id NOT IN (SELECT to_id FROM likes WHERE from_id = ?)
    AND user_id NOT IN (SELECT to_id FROM passes WHERE from_id = ?)
    ORDER BY CASE WHEN boosted_until > ? THEN 0 ELSE 1 END, RANDOM()
    LIMIT 1
  `).get(id, genderFilter, id, id, now);

  if (!match) {
    return bot.sendMessage(id, '💔 No more matches right now! Check back later.', mainMenu(id));
  }

  db.prepare('INSERT OR REPLACE INTO last_seen (user_id, last_match_id) VALUES (?, ?)').run(id, match.user_id);

  const vipBadge = match.is_vip ? '⭐ ' : '';
  const caption =
    `${vipBadge}💘 *${match.name}*, ${match.age}\n` +
    `Bio: ${match.bio}\n` +
    `Interests: ${match.interests}`;

  const inlineKeyboard = [
    [
      { text: '❤️ Like', callback_data: `like_${match.user_id}` },
      { text: '👎 Pass', callback_data: `pass_${match.user_id}` }
    ]
  ];

  if (isVip(id)) {
    inlineKeyboard.push([{ text: '↩️ Undo Last Pass', callback_data: 'undo' }]);
  }

  const buttons = { reply_markup: { inline_keyboard: inlineKeyboard } };

  if (match.photo_id) {
    bot.sendPhoto(id, match.photo_id, { caption, parse_mode: 'Markdown', ...buttons });
  } else {
    bot.sendMessage(id, caption, { parse_mode: 'Markdown', ...buttons });
  }
}

// /start
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;
  if (isBanned(id)) return bot.sendMessage(id, '🚫 You are banned from CupidBot.');

  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
  if (profile) {
    bot.sendMessage(id, `Welcome back, ${profile.name}! 💘`, mainMenu(id));
  } else {
    bot.sendMessage(id, `💘 Welcome to CupidBot!\n\nLet's set up your profile first!`, {
      reply_markup: {
        keyboard: [['💘 Create Profile']],
        resize_keyboard: true
      }
    });
  }
});

// /myid — anyone can use
bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `Your Telegram ID is: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

// Admin commands
bot.onText(/\/grantvip (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1].trim());
  db.prepare('UPDATE profiles SET is_vip = 1 WHERE user_id = ?').run(targetId);
  bot.sendMessage(msg.chat.id, `✅ VIP granted to user ${targetId}`);
  try {
    bot.sendMessage(targetId,
      `⭐ *You are now a VIP member!*\n\n` +
      `You now have access to:\n` +
      `• Unlimited likes\n` +
      `• See who liked you\n` +
      `• Undo last pass\n` +
      `• Boosted profile in matches\n\n` +
      `Enjoy! 💘`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {}
});

bot.onText(/\/removevip (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1].trim());
  db.prepare('UPDATE profiles SET is_vip = 0 WHERE user_id = ?').run(targetId);
  bot.sendMessage(msg.chat.id, `✅ VIP removed from user ${targetId}`);
  try { bot.sendMessage(targetId, `Your VIP membership has ended. Contact us to renew! 💔`); } catch (e) {}
});

bot.onText(/\/ban (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1].trim());
  db.prepare('UPDATE profiles SET is_banned = 1 WHERE user_id = ?').run(targetId);
  bot.sendMessage(msg.chat.id, `✅ User ${targetId} has been banned`);
});

bot.onText(/\/unban (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1].trim());
  db.prepare('UPDATE profiles SET is_banned = 0 WHERE user_id = ?').run(targetId);
  bot.sendMessage(msg.chat.id, `✅ User ${targetId} has been unbanned`);
});

bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const total = db.prepare('SELECT COUNT(*) as count FROM profiles').get().count;
  const vips = db.prepare('SELECT COUNT(*) as count FROM profiles WHERE is_vip = 1').get().count;
  const banned = db.prepare('SELECT COUNT(*) as count FROM profiles WHERE is_banned = 1').get().count;
  const likes = db.prepare('SELECT COUNT(*) as count FROM likes').get().count;
  bot.sendMessage(msg.chat.id,
    `📊 *Bot Stats*\n\n` +
    `👤 Total users: ${total}\n` +
    `⭐ VIP users: ${vips}\n` +
    `🚫 Banned users: ${banned}\n` +
    `❤️ Total likes: ${likes}`,
    { parse_mode: 'Markdown' }
  );
});

// Main message handler
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  if (isBanned(id)) return;

  const text = msg.text;
  if (!text) {
    const session = sessions[id];
    if (session && session.step === 'photo' && msg.photo) {
      sessions[id].photo_id = msg.photo[msg.photo.length - 1].file_id;
      finishProfile(id, msg.from.username);
      return bot.sendMessage(id, '✅ Profile saved! 💘', mainMenu(id));
    }
    return;
  }

  const session = sessions[id] || {};

  if (text === '💘 Create Profile' || text === '✏️ Edit Profile') {
    sessions[id] = { step: 'name' };
    return bot.sendMessage(id, "What's your name?", { reply_markup: { remove_keyboard: true } });
  }

  if (session.step === 'name') {
    sessions[id].name = text;
    sessions[id].step = 'age';
    return bot.sendMessage(id, 'How old are you? (must be 18+)');
  }

  if (session.step === 'age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 18) return bot.sendMessage(id, '❌ You must be 18+ to use this bot!');
    sessions[id].age = age;
    sessions[id].step = 'gender';
    return bot.sendMessage(id, 'What is your gender?', {
      reply_markup: {
        keyboard: [['Man', 'Woman', 'Non-binary']],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  }

  if (session.step === 'gender') {
    sessions[id].gender = text;
    sessions[id].step = 'looking_for';
    return bot.sendMessage(id, 'Who are you looking for?', {
      reply_markup: {
        keyboard: [['Men', 'Women', 'Everyone']],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  }

  if (session.step === 'looking_for') {
    sessions[id].looking_for = text;
    sessions[id].step = 'bio';
    return bot.sendMessage(id, 'Write a short bio about yourself:', { reply_markup: { remove_keyboard: true } });
  }

  if (session.step === 'bio') {
    sessions[id].bio = text;
    sessions[id].step = 'interests';
    return bot.sendMessage(id, 'What are your interests? (e.g. music, gaming, travel)');
  }

  if (session.step === 'interests') {
    sessions[id].interests = text;
    sessions[id].step = 'photo';
    return bot.sendMessage(id, 'Send a profile photo! Or tap skip.', {
      reply_markup: {
        keyboard: [['⏭️ Skip Photo']],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  }

  if (text === '⏭️ Skip Photo' && session.step === 'photo') {
    sessions[id].photo_id = null;
    finishProfile(id, msg.from.username);
    return bot.sendMessage(id, '✅ Profile saved! 💘', mainMenu(id));
  }

  if (text === '👤 My Profile') {
    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
    if (!profile) return bot.sendMessage(id, "No profile yet!", {
      reply_markup: { keyboard: [['💘 Create Profile']], resize_keyboard: true }
    });

    const vipBadge = profile.is_vip ? '⭐ VIP\n' : '';
    const caption =
      `${vipBadge}💘 *${profile.name}*, ${profile.age}\n` +
      `Gender: ${profile.gender}\n` +
      `Looking for: ${profile.looking_for}\n` +
      `Bio: ${profile.bio}\n` +
      `Interests: ${profile.interests}`;

    if (profile.photo_id) {
      bot.sendPhoto(id, profile.photo_id, { caption, parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(id, caption, { parse_mode: 'Markdown' });
    }
  }

  if (text === '💘 Find a Match') {
    if (!isVip(id)) {
      const used = getLikesUsedToday(id);
      if (used >= DAILY_LIKE_LIMIT) {
        return bot.sendMessage(id,
          `❤️ You've used all ${DAILY_LIKE_LIMIT} free likes today!\n\n` +
          `⭐ Get VIP for unlimited likes!\n` +
          `Tap the ⭐ Get VIP button below.`,
          mainMenu(id)
        );
      }
    }
    showMatch(id);
  }

  if (text === '💌 Who Liked Me') {
    if (!isVip(id)) {
      return bot.sendMessage(id,
        `⭐ *VIP Feature*\n\nSee everyone who liked your profile!\n\nTap ⭐ Get VIP to unlock this.`,
        { parse_mode: 'Markdown', ...mainMenu(id) }
      );
    }

    const likers = db.prepare(`
      SELECT p.name, p.age, p.user_id, p.username FROM likes l
      JOIN profiles p ON p.user_id = l.from_id
      WHERE l.to_id = ?
    `).all(id);

    if (!likers.length) return bot.sendMessage(id, "Nobody has liked you yet! Keep swiping 💘", mainMenu(id));

    const list = likers.map(l => {
      const link = l.username ? `@${l.username}` : `[${l.name}](tg://user?id=${l.user_id})`;
      return `💘 ${link}, ${l.age}`;
    }).join('\n');

    bot.sendMessage(id, `*People who liked you:*\n\n${list}`, { parse_mode: 'Markdown', ...mainMenu(id) });
  }

  if (text === '⭐ Get VIP' || text === '⭐ VIP Member') {
    if (isVip(id)) {
      return bot.sendMessage(id,
        `⭐ *You are a VIP member!*\n\n` +
        `Your perks:\n` +
        `• ♾️ Unlimited likes\n` +
        `• 💌 See who liked you\n` +
        `• ↩️ Undo last pass\n` +
        `• 🚀 Boosted profile in matches`,
        { parse_mode: 'Markdown', ...mainMenu(id) }
      );
    }
    bot.sendMessage(id,
      `⭐ *Get VIP*\n\n` +
      `Unlock these features:\n` +
      `• ♾️ Unlimited likes\n` +
      `• 💌 See who liked you\n` +
      `• ↩️ Undo last pass\n` +
      `• 🚀 Boosted profile in matches\n\n` +
      `Type /myid and send your ID to the admin to upgrade! 💘`,
      { parse_mode: 'Markdown', ...mainMenu(id) }
    );
  }

  if (text === '🗑️ Delete Profile') {
    bot.sendMessage(id, 'Are you sure you want to delete your profile?', {
      reply_markup: {
        keyboard: [['✅ Yes, Delete', '❌ No, Go Back']],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  }

  if (text === '✅ Yes, Delete') {
    db.prepare('DELETE FROM profiles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM likes WHERE from_id = ? OR to_id = ?').run(id, id);
    db.prepare('DELETE FROM passes WHERE from_id = ? OR to_id = ?').run(id, id);
    bot.sendMessage(id, '💔 Profile deleted.', {
      reply_markup: { keyboard: [['💘 Create Profile']], resize_keyboard: true }
    });
  }

  if (text === '❌ No, Go Back') {
    bot.sendMessage(id, 'Good choice! 😄', mainMenu(id));
  }
});

// Like / Pass / Undo
bot.on('callback_query', async (query) => {
  const fromId = query.from.id;
  const data = query.data;

  if (data.startsWith('like_')) {
    const toId = parseInt(data.split('_')[1]);

    if (!isVip(fromId)) {
      const used = getLikesUsedToday(fromId);
      if (used >= DAILY_LIKE_LIMIT) {
        return bot.answerCallbackQuery(query.id, {
          text: `❤️ Out of likes for today! Get VIP for unlimited.`,
          show_alert: true
        });
      }
    }

    db.prepare('INSERT OR IGNORE INTO likes (from_id, to_id) VALUES (?, ?)').run(fromId, toId);

    const mutual = db.prepare('SELECT * FROM likes WHERE from_id = ? AND to_id = ?').get(toId, fromId);

    if (mutual) {
      const me = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(fromId);
      const them = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(toId);

      const meLink = me.username ? `@${me.username}` : `[${me.name}](tg://user?id=${fromId})`;
      const themLink = them.username ? `@${them.username}` : `[${them.name}](tg://user?id=${toId})`;

      bot.sendMessage(fromId,
        `🎉 *It's a match!*\n\nYou and ${themLink} liked each other!\nTap their name to start chatting 💬`,
        { parse_mode: 'Markdown', ...mainMenu(fromId) }
      );
      bot.sendMessage(toId,
        `🎉 *It's a match!*\n\nYou and ${meLink} liked each other!\nTap their name to start chatting 💬`,
        { parse_mode: 'Markdown', ...mainMenu(toId) }
      );
    } else {
      bot.answerCallbackQuery(query.id, { text: '❤️ Liked! Keep swiping...' });
      showMatch(fromId);
    }
  }

  if (data.startsWith('pass_')) {
    const toId = parseInt(data.split('_')[1]);
    db.prepare('INSERT OR IGNORE INTO passes (from_id, to_id) VALUES (?, ?)').run(fromId, toId);
    bot.answerCallbackQuery(query.id, { text: '👎 Passed' });
    showMatch(fromId);
  }

  if (data === 'undo') {
    if (!isVip(fromId)) {
      return bot.answerCallbackQuery(query.id, { text: '⭐ VIP only feature!', show_alert: true });
    }

    const last = db.prepare('SELECT last_match_id FROM last_seen WHERE user_id = ?').get(fromId);
    if (!last) return bot.answerCallbackQuery(query.id, { text: 'Nothing to undo!', show_alert: true });

    db.prepare('DELETE FROM passes WHERE from_id = ? AND to_id = ?').run(fromId, last.last_match_id);
    db.prepare('DELETE FROM likes WHERE from_id = ? AND to_id = ?').run(fromId, last.last_match_id);
    db.prepare('DELETE FROM last_seen WHERE user_id = ?').run(fromId);

    bot.answerCallbackQuery(query.id, { text: '↩️ Undone!' });
    showMatch(fromId);
  }
});

console.log('CupidBot is running!');
