const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');

const bot = new TelegramBot(process.env.TOKEN, { polling: true });
const db = new Database('cupid.db');

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
    photo_id TEXT
  );
  CREATE TABLE IF NOT EXISTS likes (
    from_id INTEGER,
    to_id INTEGER,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE TABLE IF NOT EXISTS passes (
    from_id INTEGER,
    to_id INTEGER,
    PRIMARY KEY (from_id, to_id)
  );
`);

const sessions = {};

// Main menu buttons
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['💘 Find a Match'],
        ['👤 My Profile', '✏️ Edit Profile'],
        ['🗑️ Delete Profile']
      ],
      resize_keyboard: true
    }
  };
}

// /start
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);

  if (profile) {
    bot.sendMessage(id, `Welcome back, ${profile.name}! 💘`, mainMenu());
  } else {
    bot.sendMessage(id, `💘 Welcome to CupidBot!\n\nLet's set up your profile first!`, {
      reply_markup: {
        keyboard: [['💘 Create Profile']],
        resize_keyboard: true
      }
    });
  }
});

// Handle all button presses
bot.on('message', async (msg) => {
  const id = msg.chat.id;
  const text = msg.text;
  const session = sessions[id] || {};

  // --- Create / Edit Profile Flow ---
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
    return bot.sendMessage(id, 'Send a profile photo! Or tap the button to skip.', {
      reply_markup: {
        keyboard: [['⏭️ Skip Photo']],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  }

  if (session.step === 'photo') {
    if (msg.photo) {
      sessions[id].photo_id = msg.photo[msg.photo.length - 1].file_id;
    } else {
      sessions[id].photo_id = null;
    }
    finishProfile(id, msg.from.username);
    return bot.sendMessage(id, '✅ Profile saved! Tap the button below to start matching 💘', mainMenu());
  }

  if (text === '⏭️ Skip Photo' && session.step === 'photo') {
    sessions[id].photo_id = null;
    finishProfile(id, msg.from.username);
    return bot.sendMessage(id, '✅ Profile saved! Tap the button below to start matching 💘', mainMenu());
  }

  // --- My Profile ---
  if (text === '👤 My Profile') {
    const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
    if (!profile) return bot.sendMessage(id, "You don't have a profile yet!", {
      reply_markup: { keyboard: [['💘 Create Profile']], resize_keyboard: true }
    });

    const caption =
      `💘 *${profile.name}*, ${profile.age}\n` +
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

  // --- Find a Match ---
  if (text === '💘 Find a Match') {
    showMatch(id);
  }

  // --- Delete Profile ---
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
    bot.sendMessage(id, 'Good choice! 😄', mainMenu());
  }
});

// Show a match
function showMatch(id) {
  const me = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id);
  if (!me) return bot.sendMessage(id, 'You need a profile first!', {
    reply_markup: { keyboard: [['💘 Create Profile']], resize_keyboard: true }
  });

  const genderFilter = me.looking_for === 'Everyone' ? '%' : me.looking_for.slice(0, -1);

  const match = db.prepare(`
    SELECT * FROM profiles
    WHERE user_id != ?
    AND gender LIKE ?
    AND user_id NOT IN (SELECT to_id FROM likes WHERE from_id = ?)
    AND user_id NOT IN (SELECT to_id FROM passes WHERE from_id = ?)
    ORDER BY RANDOM() LIMIT 1
  `).get(id, genderFilter, id, id);

  if (!match) return bot.sendMessage(id, "💔 No more matches right now! Check back later.", mainMenu());

  const caption =
    `💘 *${match.name}*, ${match.age}\n` +
    `Bio: ${match.bio}\n` +
    `Interests: ${match.interests}`;

  const buttons = {
    reply_markup: {
      inline_keyboard: [[
        { text: '❤️ Like', callback_data: `like_${match.user_id}` },
        { text: '👎 Pass', callback_data: `pass_${match.user_id}` }
      ]]
    }
  };

  if (match.photo_id) {
    bot.sendPhoto(id, match.photo_id, { caption, parse_mode: 'Markdown', ...buttons });
  } else {
    bot.sendMessage(id, caption, { parse_mode: 'Markdown', ...buttons });
  }
}

// Like / Pass
bot.on('callback_query', async (query) => {
  const fromId = query.from.id;
  const data = query.data;

  if (data.startsWith('like_')) {
    const toId = parseInt(data.split('_')[1]);
    db.prepare('INSERT OR IGNORE INTO likes (from_id, to_id) VALUES (?, ?)').run(fromId, toId);

    const mutual = db.prepare('SELECT * FROM likes WHERE from_id = ? AND to_id = ?').get(toId, fromId);

    if (mutual) {
      const me = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(fromId);
      const them = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(toId);

      const meLink = me.username ? `@${me.username}` : `[${me.name}](tg://user?id=${fromId})`;
      const themLink = them.username ? `@${them.username}` : `[${them.name}](tg://user?id=${toId})`;

      bot.sendMessage(fromId,
        `🎉 *It's a match!*\n\nYou and ${themLink} liked each other!\nTap their name to start chatting 💬`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      bot.sendMessage(toId,
        `🎉 *It's a match!*\n\nYou and ${meLink} liked each other!\nTap their name to start chatting 💬`,
        { parse_mode: 'Markdown', ...mainMenu() }
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
});

function finishProfile(userId, username) {
  const s = sessions[userId];
  db.prepare(`
    INSERT OR REPLACE INTO profiles (user_id, username, name, age, gender, looking_for, bio, interests, photo_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, username || null, s.name, s.age, s.gender, s.looking_for, s.bio, s.interests, s.photo_id);
  delete sessions[userId];
}

console.log('CupidBot is running!');
