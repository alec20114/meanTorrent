'use strict';

/**
 * Module dependencies
 */
var mongoose = require('mongoose'),
  path = require('path'),
  config = require(path.resolve('./config/config')),
  Schema = mongoose.Schema,
  crypto = require('crypto'),
  validator = require('validator'),
  generatePassword = require('generate-password'),
  owasp = require('owasp-password-strength-test'),
  moment = require('moment');

owasp.config(config.shared.owasp);


/**
 * A Validation function for local strategy properties
 */
var validateLocalStrategyProperty = function (property) {
  return ((this.provider !== 'local' && !this.updated) || property.length);
};

/**
 * A Validation function for local strategy email
 */
var validateLocalStrategyEmail = function (email) {
  return ((this.provider !== 'local' && !this.updated) || validator.isEmail(email, {require_tld: false}));
};

/**
 * A Validation function for username
 * - at least 3 characters
 * - only a-z0-9_-.
 * - contain at least one alphanumeric character
 * - not in list of illegal usernames
 * - no consecutive dots: "." ok, ".." nope
 * - not begin or end with "."
 */

var validateUsername = function (username) {
  var usernameRegex = /^(?=[\w.-]+$)(?!.*[._-]{2})(?!\.)(?!.*\.$).{3,34}$/;
  return (
    this.provider !== 'local' ||
    (username && usernameRegex.test(username) && config.illegalUsernames.indexOf(username) < 0)
  );
};

/**
 * User Schema
 */
var UserSchema = new Schema({
  firstName: {
    type: String,
    trim: true,
    default: '',
    validate: [validateLocalStrategyProperty, 'Please fill in your first name']
  },
  lastName: {
    type: String,
    trim: true,
    default: '',
    validate: [validateLocalStrategyProperty, 'Please fill in your last name']
  },
  displayName: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    //index: {
    //  unique: true,
    //  sparse: true // For this to work on a previously indexed field, the index must be dropped & the application restarted.
    //},
    unique: 'email already exists',
    required: 'Please fill in a email address',
    lowercase: true,
    trim: true,
    default: '',
    validate: [validateLocalStrategyEmail, 'Please fill a valid email address']
  },
  username: {
    type: String,
    unique: 'Username already exists',
    required: 'Please fill in a username',
    validate: [validateUsername, 'Please enter a valid username: 3+ characters long, non restricted word, characters "_-.", no consecutive dots, does not begin or end with dots, letters a-z and numbers 0-9.'],
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    default: ''
  },
  passkey: {
    type: String,
    default: ''
  },
  salt: {
    type: String
  },
  profileImageURL: {
    type: String,
    default: 'modules/users/client/img/profile/default.png'
  },
  provider: {
    type: String,
    required: 'Provider is required'
  },
  providerData: {},
  additionalProvidersData: {},
  roles: {
    type: [{
      type: String,
      enum: config.meanTorrentConfig.userRoles
    }],
    default: ['user'],
    required: 'Please provide at least one role'
  },
  status: {
    type: String,
    default: 'normal'
  },
  vip_start_at: {
    type: Date,
    default: ''
  },
  vip_end_at: {
    type: Date,
    default: ''
  },
  score: {
    type: Number,
    default: 0
  },
  uploaded: {
    type: Number,
    default: 0
  },
  downloaded: {
    type: Number,
    default: 0
  },
  ratio: {
    type: Number,
    default: 0
  },
  seeded: {
    type: Number,
    default: 0
  },
  leeched: {
    type: Number,
    default: 0
  },
  finished: {
    type: Number,
    default: 0
  },
  topics: {
    type: Number,
    default: 0
  },
  replies: {
    type: Number,
    default: 0
  },
  updated: {
    type: Date
  },
  last_signed: {
    type: Date
  },
  signed_ip: [String],
  leeched_ip: [String],
  client_agent: [String],
  created: {
    type: Date,
    default: Date.now
  },
  /* For reset password */
  resetPasswordToken: {
    type: String
  },
  resetPasswordExpires: {
    type: Date
  }
});

/**
 * overwrite toJSON
 */
UserSchema.methods.toJSON = function (options) {
  var document = this.toObject(options);
  document.isVip = false;

  if (!document.vip_start_at || !document.vip_end_at) {
    document.isVip = false;
  } else if (moment(Date.now()) > moment(document.vip_end_at)) {
    document.isVip = false;
  } else {
    document.isVip = true;
  }

  if (document.roles) {
    document.isOper = (document.roles[0] === 'oper' || document.roles[0] === 'admin');
    document.isAdmin = (document.roles[0] === 'admin');
  }

  return document;
};

/**
 * Hook a pre save method to hash the password
 */
UserSchema.pre('save', function (next) {
  var user = this;

  if (this.password && this.isModified('password')) {
    this.salt = crypto.randomBytes(16).toString('base64');
    this.password = this.hashPassword(this.password);
  }

  countRatio(this);

  this.constructor.count(function (err, count) {
    if (err) {
      return next(err);
    }

    if (count === 0) {
      user.roles = ['admin'];
    }

    next();
  });
});

/**
 * Hook a pre save method to hash the password
 */
UserSchema.pre('update', function (next) {
  countRatio(this);
  next();
});

function countRatio(user) {
  if (user.uploaded > 0 && user.downloaded === 0) {
    user.ratio = -1;
  } else if (user.uploaded === 0 || user.downloaded === 0) {
    user.ratio = 0;
  } else {
    user.ratio = Math.round((user.uploaded / user.downloaded) * 100) / 100;
  }
}

/**
 * Hook a pre validate method to test the local password
 */
UserSchema.pre('validate', function (next) {
  if (this.provider === 'local' && this.password && this.isModified('password')) {
    var result = owasp.test(this.password);
    if (result.errors.length) {
      var error = result.errors.join(' ');
      this.invalidate('password', error);
    }
  }

  next();
});

/**
 * Create instance method for hashing a password
 */
UserSchema.methods.hashPassword = function (password) {
  if (this.salt && password) {
    return crypto.pbkdf2Sync(password, new Buffer(this.salt, 'base64'), 10000, 64, 'SHA1').toString('base64');
  } else {
    return password;
  }
};

/**
 * update user last signed time
 */
UserSchema.methods.updateSignedTime = function () {
  this.update({
    $set: {last_signed: Date.now()}
  }).exec();
};

/**
 * update user last signed ip
 * @param ip
 */
UserSchema.methods.addSignedIp = function (ip) {
  this.update({
    $addToSet: {signed_ip: ip}
  }).exec();
};

/**
 * update user last leeched ip
 * @param ip
 */
UserSchema.methods.addLeechedIp = function (ip) {
  this.update({
    $addToSet: {leeched_ip: ip}
  }).exec();
};

/**
 * update user last client_agent
 * @param ip
 */
UserSchema.methods.addClientAgent = function (ca) {
  this.update({
    $addToSet: {client_agent: ca}
  }).exec();
};

/**
 * Create instance method for authenticating user
 */
UserSchema.methods.authenticate = function (password) {
  return this.password === this.hashPassword(password);
};

/**
 * create randomString
 * @param length
 * @param chars
 * @returns {string}
 */
UserSchema.methods.randomString = function (length, chars) {
  if (!chars) {
    throw new Error('Argument \'chars\' is undefined');
  }

  var charsLength = chars.length;
  if (charsLength > 256) {
    throw new Error('Argument \'chars\' should not have more than 256 characters'
      + ', otherwise unpredictability will be broken');
  }

  var randomBytes = crypto.randomBytes(length);
  var result = new Array(length);

  var cursor = 0;
  for (var i = 0; i < length; i++) {
    cursor += randomBytes[i];
    result[i] = chars[cursor % charsLength];
  }

  return result.join('');
};

/**
 * create randomAsciiString
 * @param length
 * @param chars
 * @returns {string}
 */
UserSchema.methods.randomAsciiString = function (length) {
  return this.randomString(length, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
};

/**
 * Find possible not used username
 */
UserSchema.statics.findUniqueUsername = function (username, suffix, callback) {
  var _this = this;
  var possibleUsername = username.toLowerCase() + (suffix || '');

  _this.findOne({
    username: possibleUsername
  }, function (err, user) {
    if (!err) {
      if (!user) {
        callback(possibleUsername);
      } else {
        return _this.findUniqueUsername(username, (suffix || 0) + 1, callback);
      }
    } else {
      callback(null);
    }
  });
};

/**
 * Generates a random passphrase that passes the owasp test
 * Returns a promise that resolves with the generated passphrase, or rejects with an error if something goes wrong.
 * NOTE: Passphrases are only tested against the required owasp strength tests, and not the optional tests.
 */
UserSchema.statics.generateRandomPassphrase = function () {
  return new Promise(function (resolve, reject) {
    var password = '';
    var repeatingCharacters = new RegExp('(.)\\1{2,}', 'g');

    // iterate until the we have a valid passphrase
    // NOTE: Should rarely iterate more than once, but we need this to ensure no repeating characters are present
    while (password.length < 20 || repeatingCharacters.test(password)) {
      // build the random password
      password = generatePassword.generate({
        length: Math.floor(Math.random() * (20)) + 20, // randomize length between 20 and 40 characters
        numbers: true,
        symbols: false,
        uppercase: true,
        excludeSimilarCharacters: true
      });

      // check if we need to remove any repeating characters
      password = password.replace(repeatingCharacters, '');
    }

    // Send the rejection back if the passphrase fails to pass the strength test
    if (owasp.test(password).errors.length) {
      reject(new Error('An unexpected problem occured while generating the random passphrase'));
    } else {
      // resolve with the validated passphrase
      resolve(password);
    }
  });
};

mongoose.model('User', UserSchema);
