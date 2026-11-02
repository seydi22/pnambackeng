const mongoose = require('mongoose');

const appVersionConfigSchema = new mongoose.Schema(
    {
        minimumVersion: { type: String, required: true },
        latestVersion: { type: String, default: null },
        androidDownloadUrl: { type: String, default: null },
        webUrl: { type: String, default: null },
        iosDownloadUrl: { type: String, default: null },
        updateMessage: { type: String, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model('AppVersionConfig', appVersionConfigSchema);
