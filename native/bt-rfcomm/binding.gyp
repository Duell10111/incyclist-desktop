{
  "targets": [
    {
      "target_name": "bt_rfcomm",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/rfcomm.mm"],
          "link_settings": {
            "libraries": ["-framework Foundation", "-framework IOBluetooth"]
          },
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          }
        }]
      ]
    }
  ]
}
