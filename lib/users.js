var db = require('./db')
  , realtime = require('./realtime')
  ;

// ===== ROUTES =====
/**
 * Page showing all players and real time updating of these lists
 * For now just send the whole list everytime. If usage increases it will break (too much data)
 * and we'll need to implement a differential mechanism instead
 * I also need to check the data is only sent to users on the players page
 */
function allUsersPage(req, res) {
  userCDLists(realtime.getAllConnectedUsersIds(), function(err, m) {
    res.locals.connectedUsers = JSON.stringify(m.connectedUsers);
    res.locals.disconnectedUsers = JSON.stringify(m.disconnectedUsers);
    return res.render('users.jade');
  });
}


/**
 * Page displaying user details and games
 */
function userPage (req, res) {
  db.users.findOne({ _id: req.params.id }, function (err, user) {
    if (err) { return res.status(500).send("Unexpected server error"); }
    if (!user) { return res.status(404).send("Could not find user"); }
    res.locals.user = user;

    db.games.find({ blackPlayerId: user._id }, { moves: 0, deads: 0, currentMoveNumber: 0 }, function (err, games) {
      if (err) { return res.status(500).send("Unexpected server error"); }
      db.games.find({ whitePlayerId: user._id }, { moves: 0, deads: 0, currentMoveNumber: 0 }, function (err, _games) {
        if (err) { return res.status(500).send("Unexpected server error"); }

        games = games.concat(_games);
        games = games.sort(function (a, b) { return b.createdAt - a.createdAt; });
        res.locals.games = games;
        return res.render('user.jade');
      });
    });
  });
}


// ===== END OF ROUTES =====
// ===== UTILITIES =====

/**
 * Get user from email
 * cb(err, user)
 */
function getUserFromEmail (email, cb) {
  db.users.find({ email: email }, function (err, res) {
    if (err) { return cb(err); }

    if (res.length === 1) {
      return cb(null, res[0]);
    } else {
      return cb(null, null);
    }
  });
}


/**
 * Create new user
 * cb(err, newUser)
 */
function createUser(opts, cb) {
  if (!opts.email) { return cb({ fieldMissing: 'email' }); }
  if (!opts.name) { return cb({ fieldMissing: 'name' }); }

  var user = { email: opts.email, name: opts.name, dateCreated: new Date() };
  db.users.insert(user, function (err, newUser) { return cb(err, newUser); });   // Coerce signature
}


function userCDLists (connectedUsersIds, cb) {
  var m = { connectedUsers: [], disconnectedUsers: [] };
  db.users.find({ _id: { $in: connectedUsersIds } }, function (err, connectedUsers) {
    db.users.find({ $not: { _id: { $in: connectedUsersIds } } }, function (err, disconnectedUsers) {
      m.connectedUsers = connectedUsers;
      m.disconnectedUsers = disconnectedUsers;
      return cb(null, m);
    });
  });
}

// ===== END OF UTILITIES =====

realtime.on('connectedUsers.change', function (connectedUsersIds) {
  userCDLists(connectedUsersIds, function(err, m) {
    realtime.broadcast('connectedUsers.change', m);
  });
});



// Interface
module.exports.getUserFromEmail = getUserFromEmail;
module.exports.createUser = createUser;
module.exports.allUsersPage = allUsersPage;
module.exports.userPage = userPage;
