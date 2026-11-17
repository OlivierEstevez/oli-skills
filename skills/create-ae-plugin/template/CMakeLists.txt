cmake_minimum_required(VERSION 3.20)

# macOS: universal binary. Must be set before project(). Ignored on Windows.
set(CMAKE_OSX_ARCHITECTURES "x86_64;arm64" CACHE STRING "Target architectures")
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")

set(PLUGIN_VERSION "1.0.0" CACHE STRING "Plugin version, MAJOR.MINOR.BUG")
if(NOT PLUGIN_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
    message(FATAL_ERROR "PLUGIN_VERSION must be MAJOR.MINOR.BUG, got '${PLUGIN_VERSION}'.")
endif()

# Rename the plugin here and in src/Plugin_Config.h.
project(Spot VERSION ${PLUGIN_VERSION} LANGUAGES CXX)
set(PLUGIN ${PROJECT_NAME})
set(PLUGIN_BUNDLE_ID "com.example.ae.${PLUGIN}")

if(NOT APPLE AND NOT WIN32)
    message(FATAL_ERROR "After Effects plugins build on macOS and Windows only.")
endif()

# PF_VERSION packs major 0-127, minor 0-15, bug 0-15.
if(PROJECT_VERSION_MAJOR GREATER 127 OR PROJECT_VERSION_MINOR GREATER 15 OR PROJECT_VERSION_PATCH GREATER 15)
    message(FATAL_ERROR "Version ${PROJECT_VERSION} does not fit PF_VERSION.")
endif()

# The packed version must be identical in the PiPL and in GlobalSetup.
# Debug builds are PF_Stage_DEVELOP (0), Release builds PF_Stage_RELEASE (3).
set(AE_BUILD_VERSION 1)
math(EXPR AE_VERSION_BASE
    "((${PROJECT_VERSION_MAJOR} >> 3) << 26) | ((${PROJECT_VERSION_MAJOR} & 7) << 19) | (${PROJECT_VERSION_MINOR} << 15) | (${PROJECT_VERSION_PATCH} << 11) | ${AE_BUILD_VERSION}")
math(EXPR AE_VERSION_RELEASE "${AE_VERSION_BASE} | (3 << 9)")
set(AE_EFFECT_VERSION "$<IF:$<CONFIG:Debug>,${AE_VERSION_BASE},${AE_VERSION_RELEASE}>")
set(AE_STAGE_VERSION "$<IF:$<CONFIG:Debug>,PF_Stage_DEVELOP,PF_Stage_RELEASE>")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Export nothing but the entry points. Exported symbols can collide with the
# host's own libraries.
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ----------------------------------------------------------------------------
# After Effects SDK (not redistributable: keep it out of the repository)
# ----------------------------------------------------------------------------
set(AE_SDK_ROOT "${CMAKE_SOURCE_DIR}/vendored/AfterEffectsSDK/Examples"
    CACHE PATH "The Examples folder of the After Effects SDK")
set(AE_HEADERS   "${AE_SDK_ROOT}/Headers")
set(AE_UTIL      "${AE_SDK_ROOT}/Util")
set(AE_RESOURCES "${AE_SDK_ROOT}/Resources")

if(NOT EXISTS "${AE_HEADERS}/AE_Effect.h")
    message(FATAL_ERROR
        "After Effects SDK not found at ${AE_SDK_ROOT}.\n"
        "Pass -DAE_SDK_ROOT=<path to the SDK's Examples folder>.")
endif()

set(SRC_DIR "${CMAKE_SOURCE_DIR}/src")
set(PIPL_SOURCE "${SRC_DIR}/PluginPiPL.r")

add_library(${PLUGIN} MODULE
    "${SRC_DIR}/Plugin.cpp"
    "${SRC_DIR}/Plugin.h"
    "${SRC_DIR}/Plugin_Config.h"
    "${AE_UTIL}/AEGP_SuiteHandler.cpp"
    "${AE_UTIL}/MissingSuiteError.cpp"
    "${AE_UTIL}/Smart_Utils.cpp"
)

target_include_directories(${PLUGIN} PRIVATE
    "${SRC_DIR}"
    "${AE_HEADERS}"
    "${AE_HEADERS}/SP"
    "${AE_UTIL}"
    "${AE_RESOURCES}"
)

target_compile_definitions(${PLUGIN} PRIVATE
    MAJOR_VERSION=${PROJECT_VERSION_MAJOR}
    MINOR_VERSION=${PROJECT_VERSION_MINOR}
    BUG_VERSION=${PROJECT_VERSION_PATCH}
    STAGE_VERSION=${AE_STAGE_VERSION}
    BUILD_VERSION=${AE_BUILD_VERSION}
)

# Re-run the PiPL steps when the config header or the version changes.
file(CONFIGURE OUTPUT "${CMAKE_BINARY_DIR}/plugin_version.stamp" CONTENT "${PROJECT_VERSION}\n")
set(PIPL_DEPENDS "${PIPL_SOURCE}" "${SRC_DIR}/Plugin_Config.h" "${CMAKE_BINARY_DIR}/plugin_version.stamp")

if(APPLE)
    # ------------------------------------------------------------------------
    # macOS: universal .plugin bundle, PiPL compiled with Rez
    # ------------------------------------------------------------------------
    set(AE_PLUGIN_DIR "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore")

    set_target_properties(${PLUGIN} PROPERTIES
        BUNDLE TRUE
        BUNDLE_EXTENSION "plugin"
        MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/Info.plist.in"
        MACOSX_BUNDLE_BUNDLE_NAME "${PLUGIN}"
        MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
        MACOSX_BUNDLE_GUI_IDENTIFIER "${PLUGIN_BUNDLE_ID}"
        MACOSX_BUNDLE_COPYRIGHT ""
    )

    target_compile_options(${PLUGIN} PRIVATE -Wall -Wno-unused-function -Wno-multichar)

    find_library(COCOA_FRAMEWORK Cocoa REQUIRED)
    target_link_libraries(${PLUGIN} PRIVATE ${COCOA_FRAMEWORK})

    find_program(REZ_TOOL Rez PATHS /usr/bin /Applications/Xcode.app/Contents/Developer/usr/bin REQUIRED)

    set(PIPL_OUTPUT "${CMAKE_BINARY_DIR}/${PLUGIN}PiPL.rsrc")

    add_custom_command(
        OUTPUT "${PIPL_OUTPUT}"
        COMMAND ${REZ_TOOL}
            -arch x86_64 -arch arm64
            -useDF
            -o "${PIPL_OUTPUT}"
            -i "${AE_HEADERS}"
            -i "${AE_HEADERS}/SP"
            -i "${AE_RESOURCES}"
            -i "${SRC_DIR}"
            -d __MACH__
            -d AE_OS_MAC
            -d PLUGIN_EFFECT_VERSION=${AE_EFFECT_VERSION}
            "${PIPL_SOURCE}"
        DEPENDS ${PIPL_DEPENDS}
        COMMENT "Compiling PiPL"
        VERBATIM
    )
    target_sources(${PLUGIN} PRIVATE "${PIPL_OUTPUT}")

    # The PiPL goes into the bundle, then the bundle is ad-hoc signed: macOS 15
    # and later refuse to load unsigned plugins. Sign last, nothing may change
    # in the bundle afterwards. Release signing replaces this signature.
    add_custom_command(TARGET ${PLUGIN} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_BUNDLE_DIR:${PLUGIN}>/Contents/Resources"
        COMMAND ${CMAKE_COMMAND} -E copy "${PIPL_OUTPUT}"
            "$<TARGET_BUNDLE_DIR:${PLUGIN}>/Contents/Resources/${PLUGIN}PiPL.rsrc"
        COMMAND codesign --force --deep --sign - "$<TARGET_BUNDLE_DIR:${PLUGIN}>"
        COMMENT "Copying PiPL and ad-hoc signing the bundle"
        VERBATIM
    )

    install(TARGETS ${PLUGIN} LIBRARY DESTINATION "${AE_PLUGIN_DIR}" BUNDLE DESTINATION "${AE_PLUGIN_DIR}")

elseif(WIN32)
    # ------------------------------------------------------------------------
    # Windows: .aex (a DLL with the PiPL embedded as a resource), x64 or ARM64
    # ------------------------------------------------------------------------
    if(NOT MSVC)
        message(FATAL_ERROR "The Windows build requires MSVC.")
    endif()
    if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
        message(FATAL_ERROR "Only 64-bit Windows builds are supported (-A x64 or -A ARM64).")
    endif()

    enable_language(RC)

    set(AE_PLUGIN_DIR "C:/Program Files/Adobe/Common/Plug-ins/7.0/MediaCore")

    set_target_properties(${PLUGIN} PROPERTIES
        PREFIX ""
        SUFFIX ".aex"
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}$<0:>"
        PDB_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}$<0:>"
    )

    target_compile_definitions(${PLUGIN} PRIVATE MSWindows WIN32 _WINDOWS _CRT_SECURE_NO_WARNINGS NOMINMAX)
    target_include_directories(${PLUGIN} PRIVATE "${AE_HEADERS}/Win")
    target_compile_options(${PLUGIN} PRIVATE /W3 /utf-8)

    # PiPL: cl /EP (.r -> .rr), PiPLtool (.rr -> .rrc), cl /EP (.rrc -> .rc).
    # AEConfig.h picks CodeWin64X86 or CodeWinARM64 from the compiler's macros.
    set(PIPLTOOL "${AE_RESOURCES}/PiPLtool.exe")
    set(PIPL_DIR "${CMAKE_BINARY_DIR}/pipl/$<CONFIG>")
    set(PIPL_RR  "${PIPL_DIR}/${PLUGIN}PiPL.rr")
    set(PIPL_RRC "${PIPL_DIR}/${PLUGIN}PiPL.rrc")
    set(PIPL_RC  "${PIPL_DIR}/${PLUGIN}PiPL.rc")

    add_custom_command(
        OUTPUT "${PIPL_RC}"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${PIPL_DIR}"
        COMMAND "${CMAKE_CXX_COMPILER}" /nologo /EP /P "/Fi${PIPL_RR}"
            /I "${AE_HEADERS}" /I "${AE_HEADERS}/SP" /I "${AE_RESOURCES}" /I "${SRC_DIR}"
            /D PLUGIN_EFFECT_VERSION=${AE_EFFECT_VERSION}
            "/Tp${PIPL_SOURCE}"
        COMMAND "${PIPLTOOL}" "${PIPL_RR}" "${PIPL_RRC}"
        COMMAND "${CMAKE_CXX_COMPILER}" /nologo /EP /P "/Fi${PIPL_RC}" /D MSWindows "/Tp${PIPL_RRC}"
        DEPENDS ${PIPL_DEPENDS} "${PIPLTOOL}"
        COMMENT "Compiling PiPL"
        VERBATIM
    )
    target_sources(${PLUGIN} PRIVATE "${PIPL_RC}")

    install(TARGETS ${PLUGIN} LIBRARY DESTINATION "${AE_PLUGIN_DIR}")
endif()
