// electron-builder calls this before it assembles the app. The macOS dictation helper is
// compiled here so a packaged build ships a binary and the user's Mac never needs Xcode.
exports.default = async function beforePack() {
  require('./build-mac-helper.cjs').build();
};
