{
  "variables": {
    "openssl_fips": ""
  },
  "targets": [
    {
      "target_name": "print_it_now",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": [
        "native/src/addon.cc",
        "native/src/convert.cc",
        "native/src/workers.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "native/src",
        "native/third_party/pdfium/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_DISABLE_DEPRECATED"
      ],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "native/src/win/backend_win.cc",
            "native/src/win/devmode.cc",
            "native/src/win/pdfium_loader.cc",
            "native/src/win/render_win.cc",
            "native/src/win/win_util.cc"
          ],
          "defines": [
            "PIN_BACKEND_WINDOWS=1",
            "UNICODE",
            "_UNICODE",
            "WIN32_LEAN_AND_MEAN",
            "NOMINMAX"
          ],
          "libraries": [
            "-lwinspool.lib",
            "-lgdi32.lib",
            "-luser32.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/utf-8"],
              "WarningLevel": 3
            }
          }
        }],
        ["OS!='win'", {
          "sources": [
            "native/src/posix/backend_cups.cc",
            "native/src/posix/cups_dynamic.cc"
          ],
          "defines": ["PIN_BACKEND_CUPS=1"]
        }],
        ["OS=='linux'", {
          "libraries": ["-ldl"],
          "ldflags": ["-Wl,-z,now"]
        }],
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
          }
        }]
      ]
    }
  ]
}
