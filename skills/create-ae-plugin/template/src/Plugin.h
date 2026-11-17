/*	Plugin.h */
#pragma once

#define PF_DEEP_COLOR_AWARE 1	// AE_Effect.h checks this to expose 16bpc types

#include "AEConfig.h"

#ifdef AE_OS_WIN
	#include <Windows.h>
#endif

#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_EffectCBSuites.h"
#include "AE_Macros.h"
#include "Param_Utils.h"
#include "Smart_Utils.h"
#include "AEGP_SuiteHandler.h"

#include "Plugin_Config.h"

/* Version: CMake passes these from PLUGIN_VERSION. */
#ifndef MAJOR_VERSION
#define MAJOR_VERSION	1
#endif
#ifndef MINOR_VERSION
#define MINOR_VERSION	0
#endif
#ifndef BUG_VERSION
#define BUG_VERSION		0
#endif
#ifndef STAGE_VERSION
#define STAGE_VERSION	PF_Stage_DEVELOP
#endif
#ifndef BUILD_VERSION
#define BUILD_VERSION	1
#endif

/* Parameter order in the UI. Reorder freely. */
enum {
	SPOT_INPUT = 0,
	SPOT_CENTER,
	SPOT_RADIUS,
	SPOT_FEATHER,
	SPOT_AMOUNT,
	SPOT_NUM_PARAMS
};

/* Disk IDs: saved projects find parameters by these. Append only, never
 * renumber or reuse, start at 1. */
enum {
	CENTER_DISK_ID = 1,
	RADIUS_DISK_ID,
	FEATHER_DISK_ID,
	AMOUNT_DISK_ID
};

extern "C" {
	DllExport PF_Err EffectMain(
		PF_Cmd			cmd,
		PF_InData		*in_data,
		PF_OutData		*out_data,
		PF_ParamDef		*params[],
		PF_LayerDef		*output,
		void			*extra);
}
