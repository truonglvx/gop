/**
 * For now, put all real time management stuff in here, will probably need to better structure this later on
 * The realtime.initialize function is given the io object tied to the express server
 *
 * Events Emitted
 * * connectedUsers.change - { connectedUsersIds }
 * * openGames.change - No payload
 * * openGame.join / openGame.leave - { gameId, socket }
 * * openReviews.change - No payload
 */

var middlewares = require('./middlewares')
  , config = require('./config')
  , db = require('./db')
  , disconnectTimeouts = {}   // Don't count a user as disconnect right after disconnect event as a page refresh fires a disconnect then reconnect event
  , connectedUsers = {}   // Real time list of connected users with all their sockets
  , openGames = {}   // openGames[gameId][userId] gives the list of sockets from userId on gameId page
  , openReviews = {}   // openReviews[gameId][userId] - List of sockets per game and review
  ;

// TODO: move to a utility module
function removeFrom (array, element) {
  if (!array) { return [] };
  var res = [];
  array.forEach(function (e) { if (e !== element) { res.push(e); } });
  return res;
}


function Realtime () {
  this.handlers = [];   // Buffer handler registration until initialization is complete
}
require('util').inherits(Realtime, require('events'));

Realtime.prototype.initialize = function (_io) {
  var self = this;
  // Don't initialize twice
  if (this.initialized) { return; } else { this.initialized = true; }

  // Save pointer for future reference
  this.io = _io;

  // Shared session middleware
  this.io.use(function (socket, next) {
    middlewares.session(socket.request, socket.request.res, next);
  });

  this.io.on('connection', function (socket) {
    if (socket.request.session.user) {
      var user = socket.request.session.user;

      // Handle connected users status
      clearTimeout(disconnectTimeouts[user._id]);
      if (!connectedUsers[user._id]) { connectedUsers[user._id] = []; }
      connectedUsers[user._id].push(socket);
      self.emit('connectedUsers.change', self.getAllConnectedUsersIds());

      socket.on('disconnect', function () {
        connectedUsers[user._id] = removeFrom(connectedUsers[user._id], socket);
        if (connectedUsers[user._id].length === 0) {   // If some sockets remain the user still has a page open
          delete connectedUsers[user._id];
          disconnectTimeouts[user._id] = setTimeout(function () {
            self.emit('connectedUsers.change', self.getAllConnectedUsersIds());
          }, config.disconnectTimeout);
        }
      });

      // Handle open games
      var gameCheck = socket.handshake.headers.referer.match(new RegExp(config.host + '/web/game/([^\/]+)'));
      if (gameCheck) {
        var gameId = gameCheck[1];
        if (!openGames[gameId]) { openGames[gameId] = {}; }
        if (!openGames[gameId][user._id]) { openGames[gameId][user._id] = []; }
        openGames[gameId][user._id].push(socket);
        self.emit('openGame.join', { gameId: gameId, socket: socket });
        self.emit('openGames.change');

        socket.on('disconnect', function () {
          openGames[gameId][user._id] = removeFrom(openGames[gameId][user._id], socket);
          if (openGames[gameId][user._id].length === 0) { delete openGames[gameId][user._id]; }
          if (Object.keys(openGames[gameId]).length === 0) { delete openGames[gameId]; }
          self.emit('openGame.leave', { gameId: gameId, socket: socket });
          self.emit('openGames.change');
        });
      }

      // Handle open reviews
      var reviewCheck = socket.handshake.headers.referer.match(new RegExp(config.host + '/web/review/([^\/]+)'));
      if (reviewCheck) {
        var reviewId = reviewCheck[1];
        db.reviews.findOne({ _id: reviewId }, function (err, review) {
          if (!err && review && socket.connected) {   // Necessary to check that socket is still connected after database query
            var gameId = review.gameId;
            if (!openReviews[gameId]) { openReviews[gameId] = {}; }
            if (!openReviews[gameId][reviewId]) { openReviews[gameId][reviewId] = []; }
            openReviews[gameId][reviewId].push(socket);
            self.emit('openReviews.change', { gameId: gameId });

            socket.on('disconnect', function () {
              openReviews[gameId][reviewId] = removeFrom(openReviews[gameId][reviewId], socket);
              if (openReviews[gameId][reviewId].length === 0) { delete openReviews[gameId][reviewId]; }
              if (!openReviews[gameId]) { delete openReviews[gameId]; }
              self.emit('openReviews.change', { gameId: gameId });
            });
          }
        });
      }
    }
  });

  // Process handlers buffer
  for (var i = 0; i < this.handlers.length; i += 1) {
    this.registerNewHandler(this.handlers[i]);
  }
}

/**
 * Register a new socket handler
 * @param {Function} handler Handler, being passed the socket and the Realtime object as this
 *
 * TODO: use this instead of the giant mess above to handle domain-specific websocket logic
 */
Realtime.prototype.registerNewHandler = function (_handler) {
  if (this.io) {
    //var handler = _handler;
    var handler = _handler.bind(this);
    this.io.on('connection', function (socket) {
      handler(socket);
    });
  } else {
    this.handlers.push(_handler);
  }
};

Realtime.prototype.broadcast = function (event, message) {
  this.io.emit(event, message);
};

Realtime.prototype.getAllConnectedUsersIds = function () {
  return Object.keys(connectedUsers);
};

Realtime.prototype.getCurrentGamesIds = function () {
  return Object.keys(openGames);
};

// Returns all sockets connected to this challenge page, by userId
Realtime.prototype.getGameSockets = function(gameId) {
  var sockets = [];
  if (gameId && openGames[gameId]) {
    Object.keys(openGames[gameId]).forEach(function (userId) {
      sockets = sockets.concat(openGames[gameId][userId]);
    });
  }
  return sockets;
};

// Returns all sockets connected to this challenge page, by userId
Realtime.prototype.getGamePlayersSockets = function(gameId) {
  if (gameId && openGames[gameId]) {
    return (openGames[gameId]);
  } else {
    return {};
  }
};

// For a given game, get all open reviews
Realtime.prototype.getOpenReviewsIds =function (gameId) {
  if (openReviews[gameId]) {
    return Object.keys(openReviews[gameId]);
  } else {
    return [];
  }
};


// Logging for development
function printOpenObject (name, openObject) {
  console.log(Object.keys(openObject).length + ' ' + name);
  Object.keys(openObject).forEach(function (id) {
    console.log('* ' + id + ' - ' + Object.keys(openObject[id]).length);
  });
}



// Interface
module.exports = new Realtime();   // Singleton
