/*	Plugin_Config.h

	The single source of truth shared by the C++ code and the PiPL (.r).
	Only #defines here: Rez and PiPLtool also read this file.

	Rename the plugin by editing this file and the project() name in
	CMakeLists.txt. Never change PLUGIN_MATCH_NAME after shipping: saved
	projects find the effect by it. Do not start it with "ADBE ".
*/
#pragma once

#define PLUGIN_NAME			"Spot"
#define PLUGIN_MATCH_NAME	"ACME Spot"
#define PLUGIN_CATEGORY		"ACME"
#define PLUGIN_SUPPORT_URL	"https://example.com/"

/* Must equal what GlobalSetup sets. Plugin.cpp static_asserts both values,
 * so a mismatch between the PiPL and the code fails the build.
 *
 * out_flags : PF_OutFlag_DEEP_COLOR_AWARE (1<<25) | PF_OutFlag_PIX_INDEPENDENT (1<<10)
 * out_flags2: PF_OutFlag2_SUPPORTS_THREADED_RENDERING (1<<27)
 *           | PF_OutFlag2_FLOAT_COLOR_AWARE (1<<12)
 *           | PF_OutFlag2_SUPPORTS_SMART_RENDER (1<<10)
 */
#define PLUGIN_OUT_FLAGS	0x02000400
#define PLUGIN_OUT_FLAGS2	0x08001400
