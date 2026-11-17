#include "AEConfig.h"
#include "AE_EffectVers.h"
#include "Plugin_Config.h"

/* Packed PF_VERSION, passed by CMake so the PiPL and GlobalSetup agree. */
#ifndef PLUGIN_EFFECT_VERSION
	#define PLUGIN_EFFECT_VERSION 524289	/* 1.0.0 */
#endif

#ifndef AE_OS_WIN
	#include <AE_General.r>
#endif

resource 'PiPL' (16000) {
	{
		Kind { AEEffect },
		Name { PLUGIN_NAME },
		Category { PLUGIN_CATEGORY },
#ifdef AE_OS_WIN
	#if defined(AE_PROC_INTELx64)
		CodeWin64X86 {"EffectMain"},
	#elif defined(AE_PROC_ARM64)
		CodeWinARM64 {"EffectMain"},
	#endif
#else
		CodeMacIntel64 {"EffectMain"},
		CodeMacARM64 {"EffectMain"},
#endif
		AE_PiPL_Version { 2, 0 },
		AE_Effect_Spec_Version { PF_PLUG_IN_VERSION, PF_PLUG_IN_SUBVERS },
		AE_Effect_Version { PLUGIN_EFFECT_VERSION },
		AE_Effect_Info_Flags { 0 },
		AE_Effect_Global_OutFlags { PLUGIN_OUT_FLAGS },
		AE_Effect_Global_OutFlags_2 { PLUGIN_OUT_FLAGS2 },
		AE_Effect_Match_Name { PLUGIN_MATCH_NAME },
		AE_Reserved_Info { 0 },
		AE_Effect_Support_URL { PLUGIN_SUPPORT_URL }
	}
};
