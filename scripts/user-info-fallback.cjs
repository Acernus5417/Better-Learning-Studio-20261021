// Windows may deny the account lookup used by tsx in a restricted launch.
// Keep the normal OS result; fall back to the current environment only when
// that lookup itself fails.
const os = require('node:os')
const originalUserInfo = os.userInfo
os.userInfo = function userInfoWithFallback(options) {
  try {
    return originalUserInfo(options)
  } catch (error) {
    if (error?.code !== 'ERR_SYSTEM_ERROR') throw error
    return {
      uid: -1,
      gid: -1,
      username: process.env.USERNAME || process.env.USER || 'user',
      homedir: os.homedir(),
      shell: null,
    }
  }
}
